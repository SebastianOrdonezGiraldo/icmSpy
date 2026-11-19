"""Consulta opcional (desactivada por defecto) del sitio web enlazado en un perfil.

Límites: hasta 20 sitios por ejecución, portada + 1 página de contacto, solo HTTP/HTTPS en los
puertos 80/443, 3 redirecciones, 1 MB por página, tiempos de espera cortos, solo HTML.
Protección SSRF: se rechazan direcciones privadas, locales, de enlace local (metadatos de nube),
multidifusión y reservadas; la comprobación se hace al resolver cada salto de redirección y otra
vez sobre la dirección efectivamente conectada. No se envían cookies (de Instagram ni de nadie).
"""

from __future__ import annotations

import ipaddress
import re
import socket
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import urllib3
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool

from . import MAX_WEBSITES  # noqa: F401 - límite compartido con pipeline
from . import contacts as C
from .store import ContactObservation

MAX_REDIRECTS = 3
MAX_BYTES = 1_000_000
CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 10.0
PAGE_DEADLINE = 20.0
USER_AGENT = "ICM-instagram-pilot/0.1 (consulta interna de contacto publicado)"

# Plataformas de enlaces, redes sociales, acortadores y directorios: sus contactos no son del perfil.
LINK_PLATFORMS = {
    "linktr.ee", "linktree.com", "beacons.ai", "lnk.bio", "bio.link", "taplink.cc", "taplink.at",
    "campsite.bio", "solo.to", "msha.ke", "linkin.bio", "later.com", "hoo.be", "carrd.co",
    "allmylinks.com", "linkr.bio", "tap.bio", "direct.me", "flow.page", "linkfly.to", "linkbio.co",
    "wa.link", "bit.ly", "tinyurl.com", "t.co", "cutt.ly", "goo.gl", "rebrand.ly", "ow.ly", "is.gd",
    "shorturl.at", "instagram.com", "facebook.com", "fb.com", "fb.me", "tiktok.com", "youtube.com",
    "youtu.be", "twitter.com", "x.com", "linkedin.com", "threads.net", "pinterest.com", "wa.me",
    "whatsapp.com", "t.me", "telegram.me", "spotify.com", "forms.gle", "docs.google.com",
    "calendly.com", "doctoralia.com.co", "doctoralia.com", "maps.app.goo.gl", "g.page", "google.com",
    "mercadolibre.com.co", "rappi.com.co", "canva.site", "linkpop.com", "snipfeed.co", "koji.to",
}
# Dominios de correo de terceros conocidos que aparecen en plantillas de sitios.
THIRD_PARTY_EMAIL_DOMAINS = {
    "wix.com", "wixpress.com", "sentry.io", "sentry-next.wixpress.com", "example.com", "domain.com",
    "email.com", "godaddy.com", "wordpress.com", "squarespace.com", "shopify.com", "hostinger.com",
}
FREE_MAIL = {"gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.es", "live.com", "icloud.com",
             "hotmail.es", "outlook.es", "msn.com", "aol.com", "protonmail.com", "proton.me"}
THIRD_PARTY_MARKER = re.compile(
    r"desarrollad[oa] por|dise[ñn]ad[oa] por|dise[ñn]o web|p[aá]gina web por|sitio web por|"
    r"hecho por|cread[oa] por|powered by|developed by|designed by|made by|agencia",
    re.I,
)
CONTACT_LINK = re.compile(r"contact|cont[aá]ct[ae]nos|cont[aá]ctanos|escr[ií]benos|cont[aá]ctenos", re.I)
HTML_TYPES = ("text/html", "application/xhtml+xml")


class BlockedTarget(Exception):
    """Destino rechazado por la política (SSRF, esquema, puerto, tipo de contenido...)."""


# --- red segura ----------------------------------------------------------------------------------

def ip_is_public(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(
        ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_loopback
        and not ip.is_link_local and not ip.is_private and not ip.is_unspecified
    )


def check_url(url: str) -> tuple[str, str, int]:
    """Valida esquema, credenciales, puerto y nombre. Devuelve (esquema, host, puerto)."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise BlockedTarget(f"esquema no admitido: {scheme or '(vacío)'}")
    if parts.username is not None or parts.password is not None:
        raise BlockedTarget("URL con credenciales")
    try:
        port = parts.port
    except ValueError as err:
        raise BlockedTarget("puerto no válido") from err
    default = 443 if scheme == "https" else 80
    if port not in (None, default):
        raise BlockedTarget(f"puerto no admitido: {port}")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise BlockedTarget("URL sin host")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")):
        raise BlockedTarget("host local")
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    if literal:
        if not ip_is_public(host):
            raise BlockedTarget("dirección IP no pública")
    elif "." not in host:
        raise BlockedTarget("host sin dominio")
    return scheme, host, default


def resolve_public(host: str, port: int, resolver=socket.getaddrinfo) -> str:
    """Resuelve el host y exige que TODAS sus direcciones sean públicas."""
    try:
        infos = resolver(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as err:
        raise BlockedTarget(f"no resuelve: {err}") from err
    addrs = [info[4][0] for info in infos]
    if not addrs:
        raise BlockedTarget("sin direcciones")
    bad = [a for a in addrs if not ip_is_public(a)]
    if bad:
        raise BlockedTarget("el nombre resuelve a direcciones no públicas")
    return addrs[0]


class _SafeConnMixin:
    resolver = staticmethod(socket.getaddrinfo)

    def _new_conn(self):  # type: ignore[override]
        addr = resolve_public(self._dns_host, self.port, self.resolver)
        sock = socket.create_connection((addr, self.port), self.timeout, source_address=self.source_address)
        try:
            peer = sock.getpeername()[0]
        except OSError:
            peer = ""
        if not ip_is_public(peer):
            sock.close()
            raise BlockedTarget("la conexión efectiva no es a una dirección pública")
        return sock


class SafeHTTPConnection(_SafeConnMixin, HTTPConnection):
    pass


class SafeHTTPSConnection(_SafeConnMixin, HTTPSConnection):
    pass


class SafeHTTPPool(HTTPConnectionPool):
    ConnectionCls = SafeHTTPConnection


class SafeHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = SafeHTTPSConnection


def make_pool() -> urllib3.PoolManager:
    pm = urllib3.PoolManager(num_pools=4, retries=False, headers={
        "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9", "Accept-Language": "es,en;q=0.5",
    })
    pm.pool_classes_by_scheme = {"http": SafeHTTPPool, "https": SafeHTTPSPool}
    return pm


@dataclass
class Page:
    url: str
    final_url: str
    html: str


def fetch_page(pm, url: str, clock=time.monotonic) -> Page:
    """Descarga una página HTML con validación en cada salto. Lanza BlockedTarget o urllib3 errors."""
    started = clock()
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        check_url(current)
        resp = pm.request("GET", current, redirect=False, preload_content=False, retries=False,
                          timeout=urllib3.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT))
        try:
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.headers.get("Location")
                if not location:
                    raise BlockedTarget("redirección sin destino")
                current = urljoin(current, location)
                continue
            if resp.status != 200:
                raise BlockedTarget(f"HTTP {resp.status}")
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype not in HTML_TYPES:
                raise BlockedTarget(f"tipo de contenido no admitido: {ctype or '(sin tipo)'}")
            if "attachment" in (resp.headers.get("Content-Disposition") or "").lower():
                raise BlockedTarget("descarga de archivo")
            length = resp.headers.get("Content-Length")
            if length and length.isdigit() and int(length) > MAX_BYTES:
                raise BlockedTarget("página demasiado grande")
            body = bytearray()
            for chunk in resp.stream(16384):
                body.extend(chunk)
                if len(body) > MAX_BYTES:
                    raise BlockedTarget("página demasiado grande")
                if clock() - started > PAGE_DEADLINE:
                    raise BlockedTarget("tiempo agotado")
            charset = _charset(resp.headers.get("Content-Type") or "", bytes(body[:2048]))
            return Page(url=url, final_url=current, html=bytes(body).decode(charset, errors="replace"))
        finally:
            resp.release_conn()
    raise BlockedTarget("demasiadas redirecciones")


def _charset(content_type: str, head: bytes) -> str:
    m = re.search(r"charset=([\w\-]+)", content_type, re.I) or re.search(rb"charset=[\"']?([\w\-]+)", head, re.I)
    if m:
        name = m.group(1)
        name = name.decode("ascii", "ignore") if isinstance(name, bytes) else name
        try:
            "".encode(name)
            return name
        except LookupError:
            pass
    return "utf-8"


# --- análisis de la página -----------------------------------------------------------------------

@dataclass
class Anchor:
    href: str
    text: str
    context: str  # texto anterior al enlace (para detectar créditos de agencia)


@dataclass
class ParsedPage:
    text: str
    anchors: list[Anchor] = field(default_factory=list)


class _Parser(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.anchors: list[Anchor] = []
        self._skip = 0
        self._href: str | None = None
        self._atext: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag == "a":
            self._href = dict(attrs).get("href") or None
            self._atext = []
        if tag in ("br", "p", "div", "li", "tr", "footer", "section", "h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == "a" and self._href is not None:
            before = "".join(self.parts)[-120:]
            self.anchors.append(Anchor(self._href.strip(), " ".join(self._atext).strip(), before))
            self._href = None

    def handle_data(self, data):
        if self._skip:
            return
        self.parts.append(data)
        if self._href is not None:
            self._atext.append(data)


def parse_html(html: str) -> ParsedPage:
    p = _Parser()
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001 - HTML roto: se usa lo leído
        pass
    return ParsedPage(text="".join(p.parts), anchors=p.anchors)


def registrable(host: str) -> str:
    labels = host.lower().rstrip(".").split(".")
    if labels and labels[0] == "www":
        labels = labels[1:]
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in {"com", "org", "net", "gov", "edu", "co", "mil", "ac"}:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_link_platform(url: str) -> bool:
    host = (urlsplit(url if "://" in url else "https://" + url).hostname or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in LINK_PLATFORMS)


def site_candidate(external_url: str | None, bio_links: list[str]) -> str | None:
    """Primer enlace del perfil que es un sitio propio (no plataforma de enlaces ni red social)."""
    for raw in [external_url, *bio_links]:
        if not raw:
            continue
        url = raw.strip()
        if "://" not in url:
            if url.lower().startswith(("mailto:", "tel:")):
                continue
            url = "https://" + url
        if urlsplit(url).scheme.lower() not in ("http", "https"):
            continue
        if is_link_platform(url):
            continue
        return url
    return None


def attribute(contact: C.Contact, site_url: str, context: str) -> str:
    if THIRD_PARTY_MARKER.search(context or ""):
        return "third_party_suspected"
    if contact.kind == "email" and contact.normalized:
        domain = contact.normalized.rsplit("@", 1)[-1]
        if domain in THIRD_PARTY_EMAIL_DOMAINS or any(domain.endswith("." + d) for d in THIRD_PARTY_EMAIL_DOMAINS):
            return "third_party_suspected"
        site = registrable(urlsplit(site_url).hostname or "")
        if registrable(domain) == site:
            return "website_same_domain"
    return "website_unverified"


def contacts_from_page(page: Page, field_name: str) -> list[ContactObservation]:
    parsed = parse_html(page.html)
    out: list[ContactObservation] = []
    text = C._nfkc(parsed.text)
    found, _rejected = C.extract_from_text(text)
    for c in found:
        idx = text.find(c.original)
        context = text[max(0, idx - 120): idx + len(c.original) + 40] if idx >= 0 else c.evidence
        out.append(ContactObservation(c, "website", field_name, page.final_url,
                                      attribute(c, page.final_url, context)))
    for a in parsed.anchors:
        for c in C.extract_from_url(a.href, evidence_text=(a.text or a.href)[:120]):
            context = f"{a.context} {a.text}"
            out.append(ContactObservation(c, "website", field_name, page.final_url,
                                          attribute(c, page.final_url, context)))
    return out


def contact_page_url(page: Page) -> str | None:
    parsed = parse_html(page.html)
    base_host = registrable(urlsplit(page.final_url).hostname or "")
    for a in parsed.anchors:
        if not (CONTACT_LINK.search(a.href) or CONTACT_LINK.search(a.text)):
            continue
        url = urljoin(page.final_url, a.href)
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            continue
        if registrable(parts.hostname or "") != base_host:
            continue
        if url.split("#")[0] == page.final_url.split("#")[0]:
            continue
        return url.split("#")[0]
    return None


def visit_site(pm, url: str, fetch=fetch_page) -> tuple[list[dict], list[ContactObservation]]:
    """Portada + como máximo una página de contacto del mismo sitio."""
    fetches: list[dict] = []
    observations: list[ContactObservation] = []
    try:
        home = fetch(pm, url)
    except Exception as err:  # noqa: BLE001
        fetches.append({"url": url, "page": "home", "outcome": "blocked" if isinstance(err, BlockedTarget) else "error",
                        "detail": _short(err)})
        return fetches, observations
    fetches.append({"url": url, "page": "home", "final_url": home.final_url, "outcome": "ok"})
    observations += contacts_from_page(home, "website_home")
    contact_url = contact_page_url(home)
    if contact_url:
        try:
            page = fetch(pm, contact_url)
            fetches.append({"url": contact_url, "page": "contact", "final_url": page.final_url, "outcome": "ok"})
            observations += contacts_from_page(page, "website_contact")
        except Exception as err:  # noqa: BLE001
            fetches.append({"url": contact_url, "page": "contact",
                            "outcome": "blocked" if isinstance(err, BlockedTarget) else "error",
                            "detail": _short(err)})
    return fetches, observations


def _short(err: BaseException) -> str:
    from .errors import sanitize

    return sanitize(f"{type(err).__name__}: {err}", 200)
