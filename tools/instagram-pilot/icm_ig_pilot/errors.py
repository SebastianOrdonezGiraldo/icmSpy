"""Motivos de detención, clasificación de errores y saneamiento de textos para el registro."""

from __future__ import annotations

import json
import re

# Motivos de detención (se guardan en la base y se muestran en el informe).
RATE_LIMITED = "rate_limited"  # 429
RATE_WAIT_TOO_LONG = "rate_wait_too_long"  # el control de tasa pidió una espera mayor que la admitida
CHECKPOINT = "checkpoint"  # checkpoint / challenge / feedback_required
SESSION_INVALID = "session_invalid"  # sesión caducada, cerrada o de otra cuenta
ACCESS_DENIED = "access_denied"  # 403 / sin permiso
SCHEMA_CHANGED = "schema_changed"  # la respuesta no tiene la forma esperada
TIME_LIMIT = "time_limit"
CONNECTION = "connection_failed"  # red / tiempo de espera agotado tras los reintentos acotados
INTERRUPTED = "interrupted"  # Ctrl+C
CURSOR_EXPIRED = "cursor_expired"
TARGET_PRIVATE = "target_private"
TARGET_NOT_FOUND = "target_not_found"
REPEATED_FAILURES = "repeated_failures"
LIMIT_REACHED = "limit_reached"
FOLLOWERS_EXHAUSTED = "followers_exhausted"

REASON_TEXT = {
    RATE_LIMITED: "Instagram respondió 429 (demasiadas solicitudes). Se detuvo sin reintentar en bucle.",
    RATE_WAIT_TOO_LONG: "El control de tasa de Instaloader pidió una espera mayor que la admitida.",
    CHECKPOINT: "Instagram pidió una verificación (checkpoint/challenge). Resuélvala en la app o el navegador.",
    SESSION_INVALID: "La sesión no es válida, caducó o pertenece a otra cuenta.",
    ACCESS_DENIED: "Instagram denegó el acceso (403).",
    SCHEMA_CHANGED: "La respuesta de Instagram cambió de forma; no se interpreta a ciegas.",
    TIME_LIMIT: "Se alcanzó el tiempo máximo de la ejecución.",
    CONNECTION: "Fallo de red o tiempo de espera agotado tras los reintentos permitidos.",
    INTERRUPTED: "Interrumpido por el usuario (Ctrl+C).",
    CURSOR_EXPIRED: "El cursor de la lista de seguidores caducó o no corresponde a esta sesión.",
    TARGET_PRIVATE: "El perfil objetivo es privado; el piloto no lee cuentas privadas.",
    TARGET_NOT_FOUND: "El perfil objetivo no existe o no se pudo cargar.",
    REPEATED_FAILURES: "Varias consultas de perfil seguidas fallaron.",
    LIMIT_REACHED: "Se alcanzó el límite de seguidores.",
    FOLLOWERS_EXHAUSTED: "Se recorrió toda la lista de seguidores disponible.",
}

# Motivos tras los cuales `resume` tiene sentido (los demás exigen revisar algo antes).
RESUMABLE = {RATE_LIMITED, RATE_WAIT_TOO_LONG, TIME_LIMIT, CONNECTION, INTERRUPTED, REPEATED_FAILURES,
             LIMIT_REACHED, CHECKPOINT, SESSION_INVALID, ACCESS_DENIED}


class PilotStop(Exception):
    """Detención ordenada: se guarda el avance y se informa el motivo."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = sanitize(detail)


class ProfileUnavailable(Exception):
    """Un perfil concreto no existe o no se puede ver; no detiene la ejecución."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = sanitize(detail)


class ProfileFailed(Exception):
    """Fallo transitorio al consultar un perfil; se marca como fallido y se sigue."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = sanitize(detail)


_REDACTIONS = [
    (re.compile(r"(?i)(sessionid|csrftoken|ds_user_id|mid|ig_did|rur|shbid|shbts|authorization|cookie|"
                r"x-csrftoken|x-ig-www-claim|password|enc_password)([\"']?\s*[:=]\s*)[^\s;,&\"']+"),
     r"\1\2[oculto]"),
    (re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"), "[correo]"),
    (re.compile(r"\+?\d[\d\s().\-]{6,}\d"), "[número]"),
]


def sanitize(text: str | None, limit: int = 300) -> str:
    """Quita cookies, tokens, correos y números de un texto antes de registrarlo."""
    if not text:
        return ""
    out = str(text)
    for pattern, repl in _REDACTIONS:
        out = pattern.sub(repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    return out[:limit]


def _chain(exc: BaseException):
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def classify(exc: BaseException) -> PilotStop:
    """Traduce una excepción de Instaloader/requests a un motivo de detención."""
    import instaloader.exceptions as ie
    import requests

    for e in _chain(exc):
        if isinstance(e, PilotStop):
            return e
    chain = list(_chain(exc))
    text = " ".join(str(e) for e in chain).lower()
    for e in chain:
        if isinstance(e, ie.TooManyRequestsException):
            return PilotStop(RATE_LIMITED, str(e))
    if any(k in text for k in ("checkpoint", "challenge_required", "feedback_required", "challenge")):
        return PilotStop(CHECKPOINT, str(exc))
    for e in chain:
        if isinstance(e, ie.LoginRequiredException | ie.LoginException):
            return PilotStop(SESSION_INVALID, str(e))
        if isinstance(e, ie.QueryReturnedForbiddenException):
            return PilotStop(ACCESS_DENIED, str(e))
    if "429" in text or "too many requests" in text:
        return PilotStop(RATE_LIMITED, str(exc))
    if "401" in text or "login_required" in text or "please wait a few minutes" in text:
        return PilotStop(SESSION_INVALID, str(exc))
    if "403" in text or "forbidden" in text:
        return PilotStop(ACCESS_DENIED, str(exc))
    for e in chain:
        if isinstance(e, KeyError | TypeError | AttributeError | json.JSONDecodeError | ValueError):
            if not isinstance(e, requests.exceptions.RequestException):
                return PilotStop(SCHEMA_CHANGED, f"{type(e).__name__}: {e}")
    return PilotStop(CONNECTION, str(exc))
