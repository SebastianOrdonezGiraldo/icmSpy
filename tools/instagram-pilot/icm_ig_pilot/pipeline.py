"""Orquestación de una ejecución: seguidores → perfiles públicos → (opcional) sitios web.

Todo es secuencial. Cada unidad se guarda antes de pasar a la siguiente; una detención (429,
checkpoint, sesión, plazo, Ctrl+C...) deja el avance guardado y el motivo registrado.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from . import MAX_WEBSITES
from . import contacts as C
from . import web as W
from .errors import (
    CURSOR_EXPIRED,
    FOLLOWERS_EXHAUSTED,
    LIMIT_REACHED,
    REASON_TEXT,
    REPEATED_FAILURES,
    SCHEMA_CHANGED,
    PilotStop,
    ProfileFailed,
    ProfileUnavailable,
    sanitize,
)
from .gateway import Gateway, Guard
from .store import (
    ENRICHED,
    FAILED,
    INACCESSIBLE,
    PENDING,
    ContactObservation,
    FollowerStub,
    ProfileDetails,
    Store,
)
from .url import canonical_profile_url

MAX_CONSECUTIVE_FAILURES = 3


@dataclass
class Outcome:
    status: str  # completed | stopped | error
    reason: str
    detail: str


def profile_contacts(details: ProfileDetails) -> tuple[list[ContactObservation], dict[tuple[str, str], int]]:
    """Contactos publicados en el propio perfil: biografía, enlace externo y enlaces de la bio."""
    profile_url = canonical_profile_url(details.username)
    observations: list[ContactObservation] = []
    rejected: Counter[tuple[str, str]] = Counter()
    found, rej = C.extract_from_text(details.biography)
    for c in found:
        observations.append(ContactObservation(c, "instagram_profile", "biography", profile_url, "profile_owner"))
    for r in rej:
        rejected[("biography", r.reason)] += 1
    if details.external_url:
        for c in C.extract_from_url(details.external_url):
            observations.append(ContactObservation(c, "instagram_profile", "external_url", profile_url, "profile_owner"))
    for link in details.bio_links:
        if link == details.external_url:
            continue
        for c in C.extract_from_url(link):
            observations.append(ContactObservation(c, "instagram_profile", "bio_links", profile_url, "profile_owner"))
    return observations, dict(rejected)


class Pipeline:
    def __init__(self, store: Store, gateway: Gateway, guard: Guard, *, web_pool=None, web_visit=None,
                 progress=None):
        self.store = store
        self.gateway = gateway
        self.guard = guard
        self.web_pool = web_pool
        self.web_visit = web_visit or W.visit_site
        self.progress = progress or (lambda msg: None)
        self._consecutive_failures = 0

    def execute(self) -> Outcome:
        store = self.store
        store.event("info", "session_start", f"limite={store.get_run().limit_total}")
        try:
            self._enrich_pending()
            reason = self._collect()
            run = store.get_run()
            if run.include_web:
                self._web_phase()
            leftover = len(store.pending_followers())
            outcome = Outcome("completed" if leftover == 0 else "stopped", reason,
                              "" if leftover == 0 else f"{leftover} perfiles sin consultar")
        except PilotStop as stop:
            outcome = Outcome("stopped", stop.reason, stop.detail)
        except KeyboardInterrupt:
            outcome = Outcome("stopped", "interrupted", "Ctrl+C (segunda pulsación)")
        except Exception as err:  # error de programación: se registra y se propaga
            store.set_status("error", "internal_error", sanitize(f"{type(err).__name__}: {err}"))
            store.event("error", "internal_error", sanitize(f"{type(err).__name__}: {err}"))
            raise
        store.set_status(outcome.status, outcome.reason, outcome.detail)
        store.event("info" if outcome.status == "completed" else "warning", f"stop:{outcome.reason}",
                    REASON_TEXT.get(outcome.reason, "") + (f" ({outcome.detail})" if outcome.detail else ""))
        return outcome

    # --- seguidores ----------------------------------------------------------------------------

    def _collect(self) -> str:
        store = self.store
        run = store.get_run()
        if run.cursor_exhausted:
            return FOLLOWERS_EXHAUSTED
        if store.unique_followers() >= run.limit_total:
            return LIMIT_REACHED
        self.guard.check()
        cursor = self.gateway.open_followers(run.target_userid, run.target_username, run.cursor_state)
        if run.cursor_state is not None and not cursor.resumed:
            raise PilotStop(CURSOR_EXPIRED, "no se pudo continuar el cursor guardado")
        first = True
        received_this_session = 0
        while True:
            self.guard.check()
            if store.unique_followers() >= run.limit_total:
                return LIMIT_REACHED
            stub = cursor.next()
            if stub is None:
                store.mark_cursor_exhausted()
                return FOLLOWERS_EXHAUSTED
            is_replay = first and cursor.resumed and stub.user_id == run.last_follower_id
            first = False
            outcome = store.record_follower(stub, cursor.state(), is_replay=is_replay)
            received_this_session += 1
            if received_this_session > run.limit_total + 200:
                raise PilotStop(SCHEMA_CHANGED, "la lista devuelve seguidores repetidos sin avanzar")
            if outcome == "new":
                unique = store.unique_followers()
                if unique % 25 == 0:
                    store.event("info", "progress", f"seguidores_unicos={unique}")
                    self.progress(f"{unique} seguidores únicos guardados")
                if not stub.is_private:
                    self._enrich(stub)

    # --- perfiles ------------------------------------------------------------------------------

    def _enrich_pending(self) -> None:
        for row in self.store.pending_followers():
            self.guard.check()
            stub = FollowerStub(row["user_id"], row["username"], row["full_name"],
                                bool(row["is_private"]) if row["is_private"] is not None else None,
                                bool(row["is_verified"]) if row["is_verified"] is not None else None)
            self._enrich(stub)

    def _enrich(self, stub: FollowerStub) -> None:
        self.guard.check()
        try:
            details = self.gateway.fetch_profile(stub)
        except ProfileUnavailable as err:
            self.store.mark_follower(stub.user_id, INACCESSIBLE, err.detail)
            self._consecutive_failures = 0
            return
        except ProfileFailed as err:
            self.store.mark_follower(stub.user_id, FAILED, err.detail)
            self._consecutive_failures += 1
            if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                raise PilotStop(REPEATED_FAILURES, err.detail) from err
            return
        if details.user_id != stub.user_id:
            raise PilotStop(SCHEMA_CHANGED, "el perfil devuelto no corresponde al seguidor pedido")
        self._consecutive_failures = 0
        observations, rejected = profile_contacts(details)
        self.store.save_profile(stub.user_id, details, observations, rejected)

    # --- sitios web (opcional) -----------------------------------------------------------------

    def _web_phase(self) -> None:
        store = self.store
        if self.web_pool is None:
            self.web_pool = W.make_pool()
        rows = store.db.execute(
            "SELECT user_id, external_url, bio_links FROM followers WHERE status=? ORDER BY position", (ENRICHED,)
        ).fetchall()
        import json

        for row in rows:
            if store.websites_attempted() >= MAX_WEBSITES:
                break
            if store.web_done(row["user_id"]):
                continue
            url = W.site_candidate(row["external_url"], json.loads(row["bio_links"] or "[]"))
            if not url:
                continue
            self.guard.check()
            fetches, observations = self.web_visit(self.web_pool, url)
            store.save_web(row["user_id"], fetches, observations)
        store.event("info", "web_done", f"sitios_consultados={store.websites_attempted()}")


__all__ = ["Pipeline", "Outcome", "profile_contacts", "PENDING", "FAILED"]
