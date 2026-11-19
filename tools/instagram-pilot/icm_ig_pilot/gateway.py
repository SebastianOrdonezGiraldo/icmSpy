"""Acceso a Instagram a través de Instaloader 4.16, envuelto para el piloto.

- Mantiene el control de tasa de Instaloader (no se desactivan las esperas) pero no deja que una
  espera interna bloquee indefinidamente: si pide esperar más de lo admitido o más allá del plazo,
  se detiene con motivo y el avance queda guardado.
- Ante un 429 se detiene; no reintenta en bucle.
- Sin paralelismo: una sola sesión y una consulta a la vez.
- Solo lee: lista de seguidores del objetivo y el perfil de cada seguidor público.

Las pruebas usan un `Gateway` falso (ver tests/fakes.py); este módulo solo se ejercita contra
Instagram en la validación real.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol

from .errors import (
    CURSOR_EXPIRED,
    INTERRUPTED,
    RATE_LIMITED,
    RATE_WAIT_TOO_LONG,
    SCHEMA_CHANGED,
    SESSION_INVALID,
    TARGET_NOT_FOUND,
    TIME_LIMIT,
    PilotStop,
    ProfileFailed,
    ProfileUnavailable,
    classify,
)
from .store import FollowerStub, ProfileDetails

# Consultas de Instaloader 4.16 (Profile.get_followers y Profile._obtain_metadata con sesión).
FOLLOWERS_QUERY_HASH = "37479f2b8209594dde7facb0d904896a"
PROFILE_DOC_ID = "27937681195819736"

# Claves de botones de contacto que Instagram ha usado en otras interfaces. Instaloader no las
# expone como propiedades: solo se registra si aparecen (el nombre, nunca el valor).
CONTACT_KEY_HINTS = ("email", "phone", "whatsapp", "contact", "address", "city_name", "zip")


@dataclass
class TargetInfo:
    userid: str
    username: str
    full_name: str | None
    followers: int | None
    is_private: bool


class Cursor(Protocol):
    resumed: bool

    def next(self) -> FollowerStub | None: ...

    def state(self) -> dict | None: ...


class Gateway(Protocol):
    def whoami(self) -> str | None: ...

    def resolve_target(self, username: str) -> TargetInfo: ...

    def open_followers(self, userid: str, username: str, state: dict | None) -> Cursor: ...

    def fetch_profile(self, stub: FollowerStub) -> ProfileDetails: ...

    def close(self) -> None: ...


class Guard:
    """Plazo de la ejecución, Ctrl+C cooperativo y tope de esperas internas."""

    def __init__(self, deadline: float, max_wait: float = 90.0, clock=time.monotonic, sleeper=time.sleep):
        self.deadline = deadline
        self.max_wait = max_wait
        self.stop_requested = False
        self._clock = clock
        self._sleep = sleeper

    def check(self) -> None:
        if self.stop_requested:
            raise PilotStop(INTERRUPTED, "Ctrl+C")
        if self._clock() >= self.deadline:
            raise PilotStop(TIME_LIMIT, "plazo agotado")

    def wait(self, seconds: float) -> None:
        if seconds > self.max_wait:
            raise PilotStop(RATE_WAIT_TOO_LONG, f"espera pedida de {round(seconds)} s (máximo {round(self.max_wait)} s)")
        if self._clock() + seconds > self.deadline:
            raise PilotStop(TIME_LIMIT, f"la espera de {round(seconds)} s supera el plazo")
        end = self._clock() + seconds
        while (remaining := end - self._clock()) > 0:
            self.check()
            self._sleep(min(1.0, remaining))


class InstaloaderGateway:
    """Implementación real. Requiere una sesión guardada con el comando `login`."""

    def __init__(self, guard: Guard, *, request_timeout: float = 30.0):
        import instaloader
        from instaloader.instaloadercontext import RateController

        class GuardedRateController(RateController):
            def sleep(self, secs: float) -> None:  # espera del control de tasa (acotada)
                guard.wait(secs)

            def handle_429(self, query_type: str) -> None:
                raise PilotStop(RATE_LIMITED, "HTTP 429")

        self._instaloader = instaloader
        self.guard = guard
        self.loader = instaloader.Instaloader(
            sleep=True,
            quiet=True,
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
            max_connection_attempts=2,
            request_timeout=request_timeout,
            rate_controller=lambda ctx: GuardedRateController(ctx),
            fatal_status_codes=[401, 403],
            iphone_support=False,
        )

    # --- sesión --------------------------------------------------------------------------------

    def load_session(self, username: str, session_file) -> None:
        self.loader.load_session_from_file(username, str(session_file))

    def whoami(self) -> str | None:
        """Cuenta de la sesión según Instagram (una consulta). None si la sesión no es válida."""
        try:
            name = self.loader.test_login()
        except Exception as err:  # noqa: BLE001 - se clasifica
            raise classify(err) from err
        return name.lower() if name else None

    def session_user_id(self) -> str | None:
        """ID de cuenta que la propia sesión declara (cookie ds_user_id). No se imprime ni registra."""
        # Instaloader crea antes del login una cookie ds_user_id vacía (sin dominio) y Instagram añade
        # la real para .instagram.com: cookies.get() fallaría por conflicto. Se toman los valores no
        # vacíos; si hubiera dos distintos, no se puede saber la cuenta.
        try:
            values = {str(c.value) for c in self.loader.context._session.cookies
                      if c.name == "ds_user_id" and c.value}
        except Exception:  # noqa: BLE001
            return None
        if len(values) != 1:
            return None
        value = values.pop()
        return value if value.isdigit() else None

    def prepare_session_for_saving(self) -> bool:
        """Quita las cookies vacías que Instaloader crea antes del login cuando existe la real.

        Al guardar, Instaloader convierte las cookies en un diccionario por nombre; si queda la
        vacía, la sesión guardada no sirve (401). Devuelve si hay una cookie `sessionid` real.
        No imprime ni registra valores.
        """
        jar = self.loader.context._session.cookies
        cookies = list(jar)
        with_value = {c.name for c in cookies if c.value}
        for c in cookies:
            if not c.value and c.name in with_value:
                jar.clear(c.domain, c.path, c.name)
        return any(c.name == "sessionid" and c.value for c in jar)

    def verify_identity(self, user: str) -> str:
        """Comprueba que la sesión sea de `user` antes de extraer. Devuelve el método usado.

        1) test_login de Instaloader. 2) Si Instagram no responde a esa consulta (p. ej. 401
        "Please wait a few minutes"), se compara el ID que declara la sesión con el ID público
        de la cuenta. Si nada lo confirma, se detiene.
        """
        name = self.whoami()
        if name is not None:
            if name != user:
                raise PilotStop(SESSION_INVALID, "la sesión pertenece a otra cuenta")
            return "test_login"
        uid = self.session_user_id()
        if uid is None:
            raise PilotStop(SESSION_INVALID, "Instagram no reconoce la sesión y no declara cuenta")
        try:
            info = self.resolve_target(user)
        except PilotStop as stop:
            if stop.reason == TARGET_NOT_FOUND:
                raise PilotStop(SESSION_INVALID, "no se pudo confirmar la cuenta de la sesión") from stop
            raise
        if info.userid != uid:
            raise PilotStop(SESSION_INVALID, "la sesión pertenece a otra cuenta")
        return "session_cookie_vs_public_id"

    def close(self) -> None:
        try:
            self.loader.context.error_log.clear()
            self.loader.close()
        except Exception:  # noqa: BLE001
            pass

    # --- objetivo y seguidores -----------------------------------------------------------------

    def resolve_target(self, username: str) -> TargetInfo:
        ie = self._instaloader.exceptions
        try:
            profile = self._instaloader.Profile.from_username(self.loader.context, username)
            return TargetInfo(
                userid=str(profile.userid),
                username=profile.username,
                full_name=profile.full_name or None,
                followers=profile.followers,
                is_private=bool(profile.is_private),
            )
        except ie.ProfileNotExistsException as err:
            raise PilotStop(TARGET_NOT_FOUND, str(err)) from err
        except PilotStop:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from err

    def open_followers(self, userid: str, username: str, state: dict | None) -> _RealCursor:
        ie = self._instaloader.exceptions
        NodeIterator = self._instaloader.NodeIterator
        FrozenNodeIterator = self._instaloader.FrozenNodeIterator
        args = dict(
            context=self.loader.context,
            query_hash=FOLLOWERS_QUERY_HASH,
            edge_extractor=lambda d: d["data"]["user"]["edge_followed_by"],
            node_wrapper=lambda n: n,
            query_variables={"id": str(userid)},
            query_referer=f"https://www.instagram.com/{username}/",
        )
        try:
            if state is None:
                return _RealCursor(NodeIterator(**args), resumed=False)
            frozen = FrozenNodeIterator(**state)
            if not frozen.best_before or frozen.best_before < time.time():
                raise PilotStop(CURSOR_EXPIRED, "el cursor guardado superó su fecha de validez")
            # first_data evita volver a pedir la primera página: se continúa desde lo guardado.
            iterator = NodeIterator(**args, first_data=frozen.remaining_data)
            iterator.thaw(frozen)
            return _RealCursor(iterator, resumed=True)
        except ie.InvalidArgumentException as err:
            raise PilotStop(CURSOR_EXPIRED, str(err)) from err
        except PilotStop:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from err

    def fetch_profile(self, stub: FollowerStub) -> ProfileDetails:
        ie = self._instaloader.exceptions
        variables = {
            "id": str(stub.user_id),
            "render_surface": "PROFILE",
            "__relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider": True,
            "__relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider": False,
            "__relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider": False,
            "__relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider": False,
            "enable_integrity_filters": True,
        }
        try:
            data = self.loader.context.doc_id_graphql_query(PROFILE_DOC_ID, variables)
        except ie.QueryReturnedNotFoundException as err:
            raise ProfileUnavailable("404") from err
        except ie.QueryReturnedBadRequestException as err:
            if any(k in str(err).lower() for k in ("checkpoint", "challenge", "feedback")):
                raise classify(err) from err
            raise ProfileFailed(f"400: {err}") from err
        except PilotStop:
            raise
        except Exception as err:  # noqa: BLE001
            stop = classify(err)
            if stop.reason == "connection_failed":
                raise ProfileFailed(stop.detail) from err
            raise stop from err
        if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
            raise PilotStop(SCHEMA_CHANGED, "respuesta de perfil sin 'data'")
        user = data["data"].get("user")
        if user is None:
            raise ProfileUnavailable("perfil no disponible")
        node = self._instaloader.Profile._normalize_profile_data(user)
        return details_from_node(node)


class _RealCursor:
    def __init__(self, iterator, resumed: bool):
        self._it = iterator
        self.resumed = resumed

    def next(self) -> FollowerStub | None:
        try:
            node = next(self._it)
        except StopIteration:
            return None
        except PilotStop:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from err
        return stub_from_node(node)

    def state(self) -> dict | None:
        return self._it.freeze()._asdict()


def stub_from_node(node: dict) -> FollowerStub:
    if not isinstance(node, dict) or "id" not in node or "username" not in node:
        raise PilotStop(SCHEMA_CHANGED, "seguidor sin 'id' o 'username'")
    return FollowerStub(
        user_id=str(node["id"]),
        username=str(node["username"]).lower(),
        full_name=node.get("full_name") or None,
        is_private=node.get("is_private") if isinstance(node.get("is_private"), bool) else None,
        is_verified=node.get("is_verified") if isinstance(node.get("is_verified"), bool) else None,
    )


def details_from_node(node: dict) -> ProfileDetails:
    """Construye el detalle solo con claves presentes. Si faltan las básicas, es cambio de esquema."""
    missing = [k for k in ("id", "username", "biography", "is_private") if k not in node]
    if missing:
        raise PilotStop(SCHEMA_CHANGED, f"perfil sin claves {missing}")
    links: list[str] = []
    for link in node.get("bio_links") or []:
        if isinstance(link, dict) and isinstance(link.get("url"), str) and link["url"].strip():
            links.append(link["url"].strip())
    contact_keys = sorted(
        k for k, v in node.items()
        if any(h in k.lower() for h in CONTACT_KEY_HINTS) and v not in (None, "", [], {}, False)
    )
    category = node.get("business_category_name") or node.get("category_name") or None
    is_business = node.get("is_business_account")
    return ProfileDetails(
        user_id=str(node["id"]),
        username=str(node["username"]).lower(),
        full_name=node.get("full_name") or None,
        is_private=bool(node["is_private"]),
        biography=node.get("biography") or "",
        external_url=node.get("external_url") or None,
        bio_links=links,
        category=category if isinstance(category, str) else None,
        is_business=is_business if isinstance(is_business, bool) else None,
        raw_keys=sorted(node.keys()),
        contact_keys=contact_keys,
    )
