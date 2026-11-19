import socket

import pytest

from icm_ig_pilot import web as W
from icm_ig_pilot.gateway import Guard
from icm_ig_pilot.pipeline import Pipeline
from icm_ig_pilot.store import Store

from .fakes import FakeGateway, follower, profile


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/", "http://localhost/", "http://10.0.0.5/", "http://192.168.1.1/",
        "http://172.16.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/",
        "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://100.64.0.1/",
        "http://224.0.0.1/", "http://router.local/", "http://metadata.google.internal/", "http://intranet/",
        "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@example.com/",
        "http://example.com:8080/", "https://example.com:22/",
    ],
)
def test_check_url_blocks(url):
    with pytest.raises(W.BlockedTarget):
        W.check_url(url)


def test_check_url_allows_public():
    assert W.check_url("https://clinica.example.com/contacto")[1] == "clinica.example.com"


def fake_resolver(mapping):
    def resolve(host, port, type=0):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in mapping[host]]

    return resolve


def test_dns_resolving_to_private_is_blocked():
    with pytest.raises(W.BlockedTarget):
        W.resolve_public("rebind.example", 443, fake_resolver({"rebind.example": ["93.184.216.34", "10.0.0.1"]}))
    assert W.resolve_public("ok.example", 443, fake_resolver({"ok.example": ["93.184.216.34"]})) == "93.184.216.34"


def test_effective_connection_is_checked(monkeypatch):
    class FakeSock:
        def getpeername(self):
            return ("127.0.0.1", 443)

        def close(self):
            self.closed = True

    sock = FakeSock()
    monkeypatch.setattr(W.socket, "create_connection", lambda *a, **k: sock)
    conn = W.SafeHTTPSConnection("ok.example", 443)
    conn.resolver = staticmethod(fake_resolver({"ok.example": ["93.184.216.34"]}))
    with pytest.raises(W.BlockedTarget, match="efectiva"):
        conn._new_conn()
    assert sock.closed


class FakeResp:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = headers or {"Content-Type": "text/html; charset=utf-8"}
        self.body = body

    def stream(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]

    def release_conn(self):
        pass


class FakePool:
    def __init__(self, responses):
        self.responses = responses
        self.requested = []

    def request(self, method, url, **kw):
        assert kw["redirect"] is False and kw["retries"] is False
        self.requested.append(url)
        return self.responses[url]


def test_redirect_to_private_address_is_blocked():
    pool = FakePool({"https://sitio.example/": FakeResp(302, {"Location": "http://169.254.169.254/"})})
    with pytest.raises(W.BlockedTarget):
        W.fetch_page(pool, "https://sitio.example/")
    assert pool.requested == ["https://sitio.example/"]


def test_too_many_redirects_and_non_html_and_size():
    loop = {f"https://s.example/{i}": FakeResp(301, {"Location": f"/{i + 1}"}) for i in range(10)}
    with pytest.raises(W.BlockedTarget, match="redirecciones"):
        W.fetch_page(FakePool(loop), "https://s.example/0")
    exe = FakePool({"https://s.example/": FakeResp(200, {"Content-Type": "application/octet-stream"}, b"MZ")})
    with pytest.raises(W.BlockedTarget, match="tipo"):
        W.fetch_page(exe, "https://s.example/")
    big = FakePool({"https://s.example/": FakeResp(200, None, b"a" * (W.MAX_BYTES + 10))})
    with pytest.raises(W.BlockedTarget, match="grande"):
        W.fetch_page(big, "https://s.example/")


HOME = """<html><head><script>var x="script@js.example";</script></head><body>
<p>Clínica Ejemplo · info@clinica.example · Tel 604 444 5566</p>
<a href="/contacto">Contáctenos</a>
<footer>Diseñado por Agencia Web <a href="mailto:hola@agencia.example">hola@agencia.example</a>
<a href="https://wa.me/573009998877">Agencia</a></footer></body></html>"""
CONTACT = '<html><body><a href="mailto:citas@gmail.com">Citas</a> <a href="tel:+576044445566">Llamar</a></body></html>'


def test_site_attribution_and_contact_page():
    pool = FakePool({
        "https://clinica.example/": FakeResp(200, None, HOME.encode()),
        "https://clinica.example/contacto": FakeResp(200, None, CONTACT.encode()),
    })
    fetches, obs = W.visit_site(pool, "https://clinica.example/")
    assert [f["page"] for f in fetches] == ["home", "contact"]
    got = {(o.contact.kind, o.contact.normalized, o.field, o.attribution) for o in obs}
    assert ("email", "info@clinica.example", "website_home", "website_same_domain") in got
    assert ("email", "hola@agencia.example", "website_home", "third_party_suspected") in got
    assert ("whatsapp", "+573009998877", "website_home", "third_party_suspected") in got
    assert ("email", "citas@gmail.com", "website_contact", "website_unverified") in got
    assert ("phone", "+576044445566", "website_contact", "website_unverified") in got
    assert not any(o.contact.normalized == "script@js.example" for o in obs)


def test_link_platforms_are_not_visited():
    assert W.site_candidate("https://linktr.ee/clinica", ["https://wa.me/57300"]) is None
    assert W.site_candidate("https://bit.ly/x", ["https://www.clinica.example/"]) == "https://www.clinica.example/"
    assert W.site_candidate("clinica.example", []) == "https://clinica.example"
    assert W.site_candidate("mailto:a@b.co", []) is None


def test_web_phase_respects_max_sites(tmp_path):
    store = Store(tmp_path / "r" / "pilot.sqlite")
    store.create_run(run_id="r", target_input="t", target_username="t", target_userid="9", target_full_name=None,
                     target_followers_count=30, session_username="s", limit_total=30, include_web=True)
    store.begin_session()
    profiles = {str(i): profile(i, external_url=f"https://sitio{i}.example/") for i in range(1, 31)}
    gw = FakeGateway([follower(i) for i in range(1, 31)], profiles)
    visited = []

    def visit(pool, url):
        visited.append(url)
        return [{"url": url, "page": "home", "outcome": "ok", "final_url": url}], []

    Pipeline(store, gw, Guard(deadline=1e12), web_pool=object(), web_visit=visit).execute()
    assert len(visited) == W.MAX_WEBSITES == 20
    store.begin_session()
    Pipeline(store, gw, Guard(deadline=1e12), web_pool=object(), web_visit=visit).execute()
    assert len(visited) == 20  # acumulado, también al reanudar


def test_web_disabled_by_default(tmp_path):
    store = Store(tmp_path / "r" / "pilot.sqlite")
    store.create_run(run_id="r", target_input="t", target_username="t", target_userid="9", target_full_name=None,
                     target_followers_count=1, session_username="s", limit_total=5, include_web=False)
    store.begin_session()
    gw = FakeGateway([follower(1)], {"1": profile(1, external_url="https://sitio.example/")})

    def visit(pool, url):
        raise AssertionError("no debe visitar webs")

    Pipeline(store, gw, Guard(deadline=1e12), web_pool=object(), web_visit=visit).execute()
