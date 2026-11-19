"""Validación del perfil objetivo: URL de perfil de Instagram o nombre de usuario."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

ALLOWED_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}

# Primeros segmentos que no son perfiles (publicaciones, reels, historias, exploración, etc.).
RESERVED_SEGMENTS = {
    "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about",
    "developer", "legal", "privacy", "terms", "web", "api", "graphql", "challenge",
    "emails", "session", "login", "signup", "oauth", "help", "press", "jobs", "s",
    "ar", "lite", "download", "nametag", "your_activity", "settings", "static",
    "invites", "_n", "_u", "topics", "locations", "tags", "audio", "threads",
}

# Reglas de Instagram: 1 a 30 caracteres, letras, números, punto y guion bajo;
# sin punto inicial/final ni dos puntos seguidos.
USERNAME_RE = re.compile(r"^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$")


class TargetError(ValueError):
    """La entrada no identifica un perfil de Instagram admisible."""


def canonical_profile_url(username: str) -> str:
    return f"https://www.instagram.com/{username}/"


def parse_target(value: str) -> str:
    """Devuelve el nombre de usuario canónico (minúsculas) o lanza TargetError.

    Acepta `usuario`, `@usuario` o una URL https://www.instagram.com/usuario/
    (con o sin parámetros de seguimiento, que se descartan).
    """
    if not isinstance(value, str):
        raise TargetError("El objetivo debe ser texto.")
    raw = value.strip()
    if not raw:
        raise TargetError("El objetivo está vacío.")
    if any(ch.isspace() for ch in raw) or any(ord(ch) < 32 for ch in raw):
        raise TargetError("El objetivo no puede contener espacios ni caracteres de control.")

    if "/" not in raw and ":" not in raw and "\\" not in raw:
        return _check_username(raw[1:] if raw.startswith("@") else raw)

    candidate = raw
    if "://" not in candidate:
        if candidate.lower().startswith(("instagram.com/", "www.instagram.com/", "m.instagram.com/")):
            candidate = "https://" + candidate
        else:
            raise TargetError("Solo se aceptan URL de instagram.com o un nombre de usuario.")
    parts = urlsplit(candidate)
    if parts.scheme.lower() not in {"http", "https"}:
        raise TargetError("Solo se aceptan URL http(s).")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise TargetError("La URL no puede contener credenciales.")
    try:
        port = parts.port
    except ValueError as err:
        raise TargetError("Puerto no válido en la URL.") from err
    if port not in (None, 80, 443):
        raise TargetError("Puerto no admitido en la URL.")
    host = (parts.hostname or "").rstrip(".").lower()
    if host not in ALLOWED_HOSTS:
        raise TargetError(f"El dominio '{host}' no es instagram.com.")

    segments = [s for s in parts.path.split("/") if s]
    if not segments:
        raise TargetError("La URL no indica un perfil.")
    first = segments[0].lower()
    if first in RESERVED_SEGMENTS:
        raise TargetError("La URL corresponde a una publicación, reel, historia u otra sección, no a un perfil.")
    if len(segments) > 1:
        raise TargetError("La URL apunta a una subsección del perfil; use la URL del perfil.")
    return _check_username(segments[0])


def _check_username(name: str) -> str:
    username = name.strip().lower()
    if not USERNAME_RE.match(username):
        raise TargetError("Nombre de usuario de Instagram no válido.")
    if username in RESERVED_SEGMENTS:
        raise TargetError("Nombre reservado de Instagram, no es un perfil.")
    return username
