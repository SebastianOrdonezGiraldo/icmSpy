"""Persistencia local del piloto en SQLite (un archivo por ejecución).

Cada unidad de trabajo (un seguidor recibido + el estado del cursor, o el detalle de un perfil
con sus contactos) se guarda en una sola transacción: o queda todo o no queda nada.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .contacts import Contact

SCHEMA_VERSION = 1

# Estados de un seguidor.
PENDING = "pending"  # recibido, perfil aún no consultado
ENRICHED = "enriched"  # perfil público consultado
PRIVATE_SKIPPED = "private_skipped"  # cuenta privada: fila mínima, no se consulta
INACCESSIBLE = "inaccessible"  # no existe o no se pudo ver
FAILED = "failed"  # error al consultar (no es un rechazo del perfil)

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  target_input TEXT NOT NULL,
  target_username TEXT NOT NULL,
  target_userid TEXT NOT NULL,
  target_full_name TEXT,
  target_followers_count INTEGER,
  session_username TEXT NOT NULL,
  limit_total INTEGER NOT NULL,
  include_web INTEGER NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  stop_detail TEXT,
  cursor_state TEXT,
  cursor_exhausted INTEGER NOT NULL DEFAULT 0,
  cursor_generation INTEGER NOT NULL DEFAULT 1,
  last_follower_id TEXT,
  rows_received INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS followers (
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  username TEXT NOT NULL,
  full_name TEXT,
  is_private INTEGER,
  is_verified INTEGER,
  status TEXT NOT NULL,
  status_detail TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  observed_at TEXT,
  biography TEXT,
  external_url TEXT,
  bio_links TEXT,
  category TEXT,
  is_business INTEGER,
  raw_keys TEXT,
  contact_keys TEXT,
  PRIMARY KEY (run_id, user_id)
);
CREATE TABLE IF NOT EXISTS username_history (
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, user_id, username)
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original TEXT NOT NULL,
  normalized TEXT,
  e164 TEXT,
  status TEXT NOT NULL,
  extension TEXT,
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  attribution TEXT NOT NULL,
  UNIQUE (run_id, user_id, kind, original, source, field, source_url)
);
CREATE TABLE IF NOT EXISTS rejected_numbers (
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (run_id, user_id, field, reason)
);
CREATE TABLE IF NOT EXISTS web_fetches (
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  page TEXT NOT NULL,
  final_url TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (run_id, user_id, page)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT
);
"""


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class StoreError(RuntimeError):
    pass


@dataclass
class Run:
    run_id: str
    target_input: str
    target_username: str
    target_userid: str
    target_full_name: str | None
    target_followers_count: int | None
    session_username: str
    limit_total: int
    include_web: bool
    status: str
    stop_reason: str | None
    stop_detail: str | None
    cursor_state: dict | None
    cursor_exhausted: bool
    cursor_generation: int
    last_follower_id: str | None
    rows_received: int
    duplicates: int
    created_at: str
    sessions: int


@dataclass
class FollowerStub:
    """Lo que trae la lista de seguidores (sin consultar el perfil)."""

    user_id: str
    username: str
    full_name: str | None
    is_private: bool | None
    is_verified: bool | None


@dataclass
class ProfileDetails:
    """Datos del perfil público consultado. Solo lo que la respuesta trae explícitamente."""

    user_id: str
    username: str
    full_name: str | None
    is_private: bool
    biography: str
    external_url: str | None
    bio_links: list[str]
    category: str | None
    is_business: bool | None
    raw_keys: list[str]
    contact_keys: list[str]  # nombres de claves de contacto presentes (sin sus valores)


@dataclass
class ContactObservation:
    contact: Contact
    source: str  # instagram_profile | website
    field: str  # biography | external_url | bio_links | website_home | website_contact
    source_url: str
    attribution: str  # profile_owner | website_unverified | website_same_domain | third_party_suspected


class Store:
    def __init__(self, path: Path, *, fail_hook=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), isolation_level=None, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        row = self.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None:
            self.db.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(SCHEMA_VERSION),))
        elif int(row["value"]) != SCHEMA_VERSION:
            raise StoreError(f"Versión de base {row['value']} no compatible (se espera {SCHEMA_VERSION}).")
        # Gancho de pruebas: se invoca dentro de cada transacción con un nombre de punto.
        self._fail_hook = fail_hook

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def tx(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        else:
            self.db.execute("COMMIT")

    def _hook(self, point: str) -> None:
        if self._fail_hook:
            self._fail_hook(point)

    # --- ejecuciones -------------------------------------------------------------------------

    def create_run(self, *, run_id: str, target_input: str, target_username: str, target_userid: str,
                   target_full_name: str | None, target_followers_count: int | None,
                   session_username: str, limit_total: int, include_web: bool) -> Run:
        ts = now_iso()
        with self.tx() as db:
            if db.execute("SELECT 1 FROM runs").fetchone():
                raise StoreError("Esta carpeta ya contiene una ejecución; use 'resume'.")
            db.execute(
                """INSERT INTO runs(run_id, created_at, updated_at, target_input, target_username,
                   target_userid, target_full_name, target_followers_count, session_username,
                   limit_total, include_web, status)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?, 'running')""",
                (run_id, ts, ts, target_input, target_username, target_userid, target_full_name,
                 target_followers_count, session_username, limit_total, int(include_web)),
            )
        return self.get_run()

    def get_run(self) -> Run:
        row = self.db.execute("SELECT * FROM runs").fetchone()
        if row is None:
            raise StoreError("La base no contiene ninguna ejecución.")
        return Run(
            run_id=row["run_id"], target_input=row["target_input"],
            target_username=row["target_username"], target_userid=row["target_userid"],
            target_full_name=row["target_full_name"],
            target_followers_count=row["target_followers_count"],
            session_username=row["session_username"], limit_total=row["limit_total"],
            include_web=bool(row["include_web"]), status=row["status"],
            stop_reason=row["stop_reason"], stop_detail=row["stop_detail"],
            cursor_state=json.loads(row["cursor_state"]) if row["cursor_state"] else None,
            cursor_exhausted=bool(row["cursor_exhausted"]),
            cursor_generation=row["cursor_generation"],
            last_follower_id=row["last_follower_id"], rows_received=row["rows_received"],
            duplicates=row["duplicates"], created_at=row["created_at"], sessions=row["sessions"],
        )

    def set_status(self, status: str, reason: str | None = None, detail: str | None = None) -> None:
        with self.tx() as db:
            db.execute("UPDATE runs SET status=?, stop_reason=?, stop_detail=?, updated_at=?",
                       (status, reason, detail, now_iso()))

    def begin_session(self, *, limit_total: int | None = None, include_web: bool | None = None) -> None:
        with self.tx() as db:
            db.execute("UPDATE runs SET sessions = sessions + 1, status='running', stop_reason=NULL, "
                       "stop_detail=NULL, updated_at=?", (now_iso(),))
            if limit_total is not None:
                db.execute("UPDATE runs SET limit_total=?", (limit_total,))
            if include_web is not None:
                db.execute("UPDATE runs SET include_web=?", (int(include_web),))

    def reset_cursor(self) -> None:
        """Descarta un cursor caducado: la lista se vuelve a leer desde el principio."""
        with self.tx() as db:
            db.execute("UPDATE runs SET cursor_state=NULL, cursor_exhausted=0, last_follower_id=NULL, "
                       "cursor_generation = cursor_generation + 1, updated_at=?", (now_iso(),))

    def mark_cursor_exhausted(self) -> None:
        with self.tx() as db:
            db.execute("UPDATE runs SET cursor_exhausted=1, updated_at=?", (now_iso(),))

    # --- seguidores --------------------------------------------------------------------------

    def unique_followers(self) -> int:
        return self.db.execute("SELECT count(*) FROM followers").fetchone()[0]

    def record_follower(self, stub: FollowerStub, cursor_state: dict | None, *, is_replay: bool) -> str:
        """Guarda un seguidor recibido y el estado del cursor en una sola transacción.

        `is_replay` indica que el cursor reanudado devolvió de nuevo el último elemento ya guardado
        (comportamiento de Instaloader al congelar): no cuenta como fila nueva ni como duplicado.
        Devuelve 'new', 'duplicate' o 'replay'.
        """
        ts = now_iso()
        run = self.get_run()
        with self.tx() as db:
            existing = db.execute("SELECT username FROM followers WHERE user_id=?", (stub.user_id,)).fetchone()
            if is_replay and existing is not None:
                outcome = "replay"
            elif existing is None:
                position = db.execute("SELECT coalesce(max(position), 0) + 1 FROM followers").fetchone()[0]
                status = PRIVATE_SKIPPED if stub.is_private else PENDING
                db.execute(
                    """INSERT INTO followers(run_id, user_id, position, username, full_name, is_private,
                       is_verified, status, first_seen_at, last_seen_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (run.run_id, stub.user_id, position, stub.username,
                     None if stub.is_private else stub.full_name,
                     _bool(stub.is_private), _bool(stub.is_verified), status, ts, ts),
                )
                db.execute("INSERT OR IGNORE INTO username_history VALUES(?,?,?,?)",
                           (run.run_id, stub.user_id, stub.username, ts))
                outcome = "new"
            else:
                db.execute("UPDATE followers SET times_seen = times_seen + 1, last_seen_at=? WHERE user_id=?",
                           (ts, stub.user_id))
                if existing["username"] != stub.username:
                    db.execute("UPDATE followers SET username=? WHERE user_id=?", (stub.username, stub.user_id))
                    db.execute("INSERT OR IGNORE INTO username_history VALUES(?,?,?,?)",
                               (run.run_id, stub.user_id, stub.username, ts))
                outcome = "duplicate"
            self._hook("follower_saved")
            if outcome != "replay":
                db.execute("UPDATE runs SET rows_received = rows_received + 1, duplicates = duplicates + ?",
                           (1 if outcome == "duplicate" else 0,))
            db.execute("UPDATE runs SET cursor_state=?, last_follower_id=?, updated_at=?",
                       (json.dumps(cursor_state) if cursor_state is not None else None, stub.user_id, ts))
            self._hook("cursor_saved")
        return outcome

    def pending_followers(self) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT * FROM followers WHERE status IN (?, ?) ORDER BY position", (PENDING, FAILED)
        ).fetchall()

    def save_profile(self, user_id: str, details: ProfileDetails,
                     observations: Iterable[ContactObservation],
                     rejected: dict[tuple[str, str], int]) -> None:
        ts = now_iso()
        run_id = self.get_run().run_id
        with self.tx() as db:
            if details.is_private:
                # Se volvió privado entre la lista y la consulta: no se guarda contenido.
                db.execute("UPDATE followers SET status=?, is_private=1, full_name=NULL, observed_at=? "
                           "WHERE user_id=?", (PRIVATE_SKIPPED, ts, user_id))
                return
            row = db.execute("SELECT username FROM followers WHERE user_id=?", (user_id,)).fetchone()
            if row is None:
                raise StoreError("Perfil consultado sin seguidor registrado.")
            if row["username"] != details.username:
                db.execute("INSERT OR IGNORE INTO username_history VALUES(?,?,?,?)",
                           (run_id, user_id, details.username, ts))
            db.execute(
                """UPDATE followers SET status=?, status_detail=NULL, username=?, full_name=?, is_private=0,
                   observed_at=?, biography=?, external_url=?, bio_links=?, category=?, is_business=?,
                   raw_keys=?, contact_keys=? WHERE user_id=?""",
                (ENRICHED, details.username, details.full_name, ts, details.biography,
                 details.external_url, json.dumps(details.bio_links), details.category,
                 _bool(details.is_business), json.dumps(details.raw_keys),
                 json.dumps(details.contact_keys), user_id),
            )
            self._insert_observations(db, run_id, user_id, observations, ts)
            for (field, reason), count in rejected.items():
                db.execute(
                    "INSERT INTO rejected_numbers VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET count=excluded.count",
                    (run_id, user_id, field, reason, count),
                )
            self._hook("profile_saved")

    def mark_follower(self, user_id: str, status: str, detail: str | None = None) -> None:
        with self.tx() as db:
            db.execute("UPDATE followers SET status=?, status_detail=?, observed_at=? WHERE user_id=?",
                       (status, detail, now_iso(), user_id))

    def _insert_observations(self, db, run_id: str, user_id: str,
                             observations: Iterable[ContactObservation], ts: str) -> None:
        for obs in observations:
            c = obs.contact
            db.execute(
                """INSERT OR IGNORE INTO contacts(run_id, user_id, kind, original, normalized, e164, status,
                   extension, method, source, field, source_url, observed_at, evidence, attribution)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (run_id, user_id, c.kind, c.original, c.normalized, c.e164, c.status, c.extension,
                 c.method, obs.source, obs.field, obs.source_url, ts, c.evidence, obs.attribution),
            )

    # --- web -----------------------------------------------------------------------------------

    def websites_attempted(self) -> int:
        return self.db.execute(
            "SELECT count(DISTINCT user_id) FROM web_fetches WHERE page='home'").fetchone()[0]

    def web_done(self, user_id: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM web_fetches WHERE user_id=? AND page='home'", (user_id,)).fetchone() is not None

    def save_web(self, user_id: str, fetches: list[dict], observations: list[ContactObservation]) -> None:
        ts = now_iso()
        run_id = self.get_run().run_id
        with self.tx() as db:
            for f in fetches:
                db.execute(
                    """INSERT OR REPLACE INTO web_fetches(run_id, user_id, url, page, final_url, outcome,
                       detail, fetched_at) VALUES(?,?,?,?,?,?,?,?)""",
                    (run_id, user_id, f["url"], f["page"], f.get("final_url"), f["outcome"],
                     f.get("detail"), ts),
                )
            self._insert_observations(db, run_id, user_id, observations, ts)

    # --- eventos -------------------------------------------------------------------------------

    def event(self, level: str, code: str, detail: str | None = None) -> None:
        run_id = self.db.execute("SELECT run_id FROM runs").fetchone()
        with self.tx() as db:
            db.execute("INSERT INTO events(run_id, at, level, code, detail) VALUES(?,?,?,?,?)",
                       (run_id[0] if run_id else "-", now_iso(), level, code, detail))


def _bool(v: bool | None) -> int | None:
    return None if v is None else int(bool(v))
