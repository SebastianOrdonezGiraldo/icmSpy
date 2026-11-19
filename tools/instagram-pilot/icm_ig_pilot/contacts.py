"""Extracción determinista de correos y teléfonos publicados (sin IA, sin inferencias).

Reglas:
- Solo se extrae lo que aparece escrito o enlazado; nunca se construyen correos a partir de
  nombres o dominios.
- Un teléfono solo se lleva a E.164 si trae evidencia de país: prefijo "+" o un enlace de
  WhatsApp (wa.me exige el número en formato internacional). Nunca se asume +57.
- Un número sin prefijo se conserva como "ambiguo" (solo dígitos, sin E.164).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlsplit

import phonenumbers

# Estados de un contacto.
EMAIL_SYNTAX_OK = "email_syntax_ok"
PHONE_E164 = "e164_valid"  # tiene prefijo internacional y phonenumbers lo valida
PHONE_INTL_UNVERIFIED = "international_unverified"  # tiene prefijo, pero no se valida
PHONE_AMBIGUOUS = "ambiguous_no_country"  # sin prefijo: no se asigna país
WA_WITHOUT_NUMBER = "link_without_number"  # wa.me/message/... u otros sin número visible


@dataclass(frozen=True)
class Contact:
    kind: str  # email | phone | whatsapp
    original: str
    normalized: str | None
    e164: str | None
    status: str
    extension: str | None
    method: str  # text | mailto | tel | whatsapp_link
    evidence: str


@dataclass(frozen=True)
class Rejected:
    """Secuencia numérica descartada como teléfono, con el motivo (solo para conteos)."""

    original: str
    reason: str


EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+])"
    r"([A-Za-z0-9](?:[A-Za-z0-9._%+\-]{0,62}[A-Za-z0-9_%+\-])?)"
    r"@"
    r"((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})"
    r"(?![A-Za-z0-9\-@])"
)
# Terminaciones que en realidad son archivos (logo@2x.png) o marcadores.
NOT_EMAIL_TLDS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "css", "js", "ico", "bmp", "tif", "tiff"}

PLUS_PHONE_RE = re.compile(r"\+\s?\d[\d\s().\-]{5,22}\d")
BARE_PHONE_RE = re.compile(r"(?<![\w+@/.,$])\(?\d[\d\s().\-]{5,24}\d(?![\w@%])")
EXTENSION_RE = re.compile(r"^\s*(?:,\s*)?(?:ext\.?|extensi[oó]n|x|opc\.?|opci[oó]n)\s*:?\s*(\d{1,6})", re.I)
WA_URL_IN_TEXT_RE = re.compile(
    r"(?:https?://)?(?:www\.)?(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp\.com)/[^\s<>\"']*",
    re.I,
)
SPLIT_JOINED_RE = re.compile(r"\s+[-–/|]\s*|\s*[-–/|]\s+|\s{2,}")

IDENTIFIER_BEFORE_RE = re.compile(
    r"(?:\bnit|\bc\.?\s?c|\bce|\brut|\bregistro|\breg|\binvima|\bc[oó]d(?:igo)?|\bref|\blote|"
    r"\bresoluci[oó]n|\bmatr[ií]cula|\btarjeta profesional|\bt\.?\s?p|\brm|\blicencia|\bid|"
    r"\bpedido|\borden|\bfactura|\bcuenta|\bnro\.?\s?de\s?cuenta)\b[\s.:#°nºo-]*$",
    re.I,
)
MONEY_BEFORE_RE = re.compile(r"(?:\$|\bcop|\busd|\beur)\s*$", re.I)
MONEY_AFTER_RE = re.compile(r"^\s*(?:cop|usd|eur|pesos|mil|millones|k)\b", re.I)
DATE_RE = re.compile(r"^\d{1,4}\s?[/.\-]\s?\d{1,2}\s?[/.\-]\s?\d{1,4}$")
YEAR_RANGE_RE = re.compile(r"^(?:19|20)\d{2}\s?[-–]\s?(?:19|20)\d{2}$")
THOUSANDS_RE = re.compile(r"^\d{1,3}(?:\.\d{3}){2,4}(?:-\d)?$")

MIN_DIGITS = 7
MAX_DIGITS = 15


def _nfkc(text: str) -> str:
    return unicodedata.normalize("NFKC", text or "")


def _snippet(text: str, start: int, end: int, margin: int = 30) -> str:
    a = max(0, start - margin)
    b = min(len(text), end + margin)
    s = re.sub(r"\s+", " ", text[a:b]).strip()
    return ("…" if a > 0 else "") + s + ("…" if b < len(text) else "")


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def normalize_email(local: str, domain: str) -> str | None:
    if ".." in local or local.startswith(".") or local.endswith("."):
        return None
    tld = domain.rsplit(".", 1)[-1].lower()
    if tld in NOT_EMAIL_TLDS:
        return None
    return f"{local.lower()}@{domain.lower()}"


def extract_emails(text: str, method: str = "text") -> list[Contact]:
    text = _nfkc(text)
    out: list[Contact] = []
    for m in EMAIL_RE.finditer(text):
        normalized = normalize_email(m.group(1), m.group(2))
        if normalized is None:
            continue
        out.append(
            Contact("email", m.group(0), normalized, None, EMAIL_SYNTAX_OK, None, method,
                    _snippet(text, m.start(), m.end()))
        )
    return out


def _international(candidate: str, extension: str | None, kind: str, method: str,
                   original: str, evidence: str) -> Contact:
    """Número con evidencia de prefijo internacional (+ o enlace de WhatsApp)."""
    digits = _digits(candidate)
    normalized = "+" + digits
    try:
        parsed = phonenumbers.parse(normalized, None)
        if phonenumbers.is_valid_number(parsed):
            e164 = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
            return Contact(kind, original, e164, e164, PHONE_E164, extension, method, evidence)
    except phonenumbers.NumberParseException:
        pass
    return Contact(kind, original, normalized, None, PHONE_INTL_UNVERIFIED, extension, method, evidence)


def _extension_after(text: str, end: int) -> tuple[str | None, int]:
    m = EXTENSION_RE.match(text[end:end + 30])
    if m:
        return m.group(1), end + m.end()
    return None, end


def _reject_reason(text: str, start: int, end: int, candidate: str) -> str | None:
    digits = _digits(candidate)
    stripped = candidate.strip()
    if len(digits) < MIN_DIGITS:
        return "too_short"
    if DATE_RE.match(stripped):
        return "date"
    if YEAR_RANGE_RE.match(stripped):
        return "year_range"
    before = text[max(0, start - 30):start]
    after = text[end:end + 15]
    if IDENTIFIER_BEFORE_RE.search(before):
        return "identifier"
    if MONEY_BEFORE_RE.search(before) or MONEY_AFTER_RE.match(after):
        return "money"
    if THOUSANDS_RE.match(stripped):
        return "identifier_or_amount"
    if after.lstrip().startswith("%"):
        return "percentage"
    if len(digits) > MAX_DIGITS:
        return "too_long"
    return None


def extract_phones(text: str, method: str = "text", skip_spans: list[tuple[int, int]] | None = None
                   ) -> tuple[list[Contact], list[Rejected]]:
    text = _nfkc(text)
    contacts: list[Contact] = []
    rejected: list[Rejected] = []
    taken: list[tuple[int, int]] = list(skip_spans or [])

    def overlaps(a: int, b: int) -> bool:
        return any(a < y and x < b for x, y in taken)

    for m in PLUS_PHONE_RE.finditer(text):
        if overlaps(m.start(), m.end()):
            continue
        candidate = m.group(0).rstrip(" .-(")
        digits = _digits(candidate)
        if len(digits) < MIN_DIGITS or len(digits) > MAX_DIGITS:
            rejected.append(Rejected(candidate, "too_short" if len(digits) < MIN_DIGITS else "too_long"))
            taken.append((m.start(), m.end()))
            continue
        ext, ext_end = _extension_after(text, m.start() + len(candidate))
        evidence = _snippet(text, m.start(), ext_end)
        contacts.append(_international(candidate, ext, "phone", method, candidate.strip(), evidence))
        taken.append((m.start(), ext_end))

    for m in BARE_PHONE_RE.finditer(text):
        if overlaps(m.start(), m.end()):
            continue
        candidate = m.group(0).rstrip(" .-(")
        pieces = [(candidate, m.start())]
        if len(_digits(candidate)) > MAX_DIGITS:
            pieces = []
            offset = 0
            for part in SPLIT_JOINED_RE.split(candidate):
                idx = candidate.find(part, offset)
                offset = idx + len(part)
                if part.strip():
                    pieces.append((part, m.start() + idx))
        for piece, start in pieces:
            piece = piece.strip(" .-")
            if not piece:
                continue
            start = text.find(piece, start)
            end = start + len(piece)
            reason = _reject_reason(text, start, end, piece)
            if reason:
                rejected.append(Rejected(piece, reason))
                continue
            ext, ext_end = _extension_after(text, end)
            digits = _digits(piece)
            contacts.append(
                Contact("phone", piece, digits, None, PHONE_AMBIGUOUS, ext, method,
                        _snippet(text, start, ext_end))
            )
        taken.append((m.start(), m.end()))
    return contacts, rejected


def extract_from_url(url: str, evidence_text: str | None = None) -> list[Contact]:
    """Contactos contenidos en un enlace: mailto:, tel:, wa.me y api.whatsapp.com."""
    if not url:
        return []
    raw = _nfkc(url.strip())
    lower = raw.lower()
    evidence = evidence_text or raw[:120]
    if lower.startswith("mailto:"):
        target = unquote(raw[7:].split("?", 1)[0])
        return [Contact(c.kind, raw[:200], c.normalized, None, c.status, None, "mailto", evidence)
                for c in extract_emails(target, "mailto")]
    if lower.startswith("tel:"):
        value = unquote(raw[4:])
        number, _, rest = value.partition(";")
        ext = None
        m = re.search(r"(?:^|;)ext=(\d{1,6})", rest, re.I)
        if m:
            ext = m.group(1)
        digits = _digits(number)
        if not (MIN_DIGITS <= len(digits) <= MAX_DIGITS):
            return []
        if number.strip().startswith("+"):
            return [_international(number, ext, "phone", "tel", raw[:200], evidence)]
        return [Contact("phone", raw[:200], digits, None, PHONE_AMBIGUOUS, ext, "tel", evidence)]

    candidate = raw if "://" in raw else "https://" + raw
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return []
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host == "wa.me":
        segments = [s for s in parts.path.split("/") if s]
        if segments and re.fullmatch(r"\+?\d[\d\-]{6,20}", unquote(segments[0])):
            number = _digits(unquote(segments[0]))
            if MIN_DIGITS <= len(number) <= MAX_DIGITS:
                return [_international(number, None, "whatsapp", "whatsapp_link", raw[:200], evidence)]
        return [Contact("whatsapp", raw[:200], None, None, WA_WITHOUT_NUMBER, None, "whatsapp_link", evidence)]
    if host in {"api.whatsapp.com", "web.whatsapp.com", "whatsapp.com"}:
        phone = parse_qs(parts.query).get("phone", [""])[0]
        number = _digits(phone)
        if MIN_DIGITS <= len(number) <= MAX_DIGITS:
            return [_international(number, None, "whatsapp", "whatsapp_link", raw[:200], evidence)]
        return [Contact("whatsapp", raw[:200], None, None, WA_WITHOUT_NUMBER, None, "whatsapp_link", evidence)]
    return []


def extract_from_text(text: str) -> tuple[list[Contact], list[Rejected]]:
    """Correos, enlaces de WhatsApp y teléfonos escritos en un texto (biografía, página web)."""
    text = _nfkc(text)
    found: list[Contact] = []
    spans: list[tuple[int, int]] = []
    for m in WA_URL_IN_TEXT_RE.finditer(text):
        url = m.group(0).rstrip(").,;")
        found.extend(extract_from_url(url, _snippet(text, m.start(), m.end())))
        spans.append((m.start(), m.end()))
    for c in extract_emails(text):
        found.append(c)
    for m in EMAIL_RE.finditer(text):
        spans.append((m.start(), m.end()))
    phones, rejected = extract_phones(text, "text", spans)
    found.extend(phones)
    return dedupe(found), rejected


def dedupe(contacts: list[Contact]) -> list[Contact]:
    seen: set[tuple[str, str]] = set()
    out: list[Contact] = []
    for c in contacts:
        key = (c.kind, c.normalized or c.original)
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out
