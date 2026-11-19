"""Partes del envoltorio real que se pueden comprobar sin red."""

import time

import instaloader.exceptions as ie
import pytest
import requests

from icm_ig_pilot import errors as E
from icm_ig_pilot.gateway import Guard, InstaloaderGateway, details_from_node, stub_from_node


def test_guard_caps_internal_waits():
    t = {"now": 0.0}
    guard = Guard(deadline=100, max_wait=30, clock=lambda: t["now"], sleeper=lambda s: t.__setitem__("now", t["now"] + s))
    guard.wait(10)
    assert t["now"] == 10
    with pytest.raises(E.PilotStop) as exc:
        guard.wait(31)
    assert exc.value.reason == E.RATE_WAIT_TOO_LONG
    t["now"] = 95
    with pytest.raises(E.PilotStop) as exc:
        guard.wait(10)
    assert exc.value.reason == E.TIME_LIMIT


def test_guard_wait_is_interruptible():
    t = {"now": 0.0}
    guard = Guard(deadline=100, clock=lambda: t["now"])

    def sleeper(s):
        t["now"] += s
        guard.stop_requested = True

    guard._sleep = sleeper
    with pytest.raises(E.PilotStop) as exc:
        guard.wait(20)
    assert exc.value.reason == E.INTERRUPTED and t["now"] == 1


def test_rate_controller_is_bounded_and_429_stops():
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60, max_wait=5))
    rc = gw.loader.context._rate_controller
    with pytest.raises(E.PilotStop) as exc:
        rc.sleep(600)  # una espera interna larga no bloquea
    assert exc.value.reason == E.RATE_WAIT_TOO_LONG
    with pytest.raises(E.PilotStop) as exc:
        rc.handle_429("graphql")
    assert exc.value.reason == E.RATE_LIMITED
    assert gw.loader.context.sleep is True  # el control de tasa sigue activo
    assert gw.loader.context.max_connection_attempts == 2
    assert gw.loader.context.request_timeout == 30.0


def _frozen(best_before, username="icm_tester"):
    return {
        "query_hash": "37479f2b8209594dde7facb0d904896a",
        "query_variables": {"id": "999"},
        "query_referer": "https://www.instagram.com/objetivo/",
        "context_username": username,
        "total_index": 1,
        "best_before": best_before,
        "remaining_data": {
            "edges": [{"node": {"id": "2", "username": "b", "is_private": False}},
                      {"node": {"id": "3", "username": "c", "is_private": True}}],
            "page_info": {"has_next_page": False, "end_cursor": None},
        },
        "first_node": {"id": "1", "username": "a"},
        "doc_id": None,
    }


def test_real_cursor_resumes_from_frozen_state_without_network():
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    gw.loader.context.username = "icm_tester"
    cursor = gw.open_followers("999", "objetivo", _frozen(time.time() + 3600))
    assert cursor.resumed
    assert [cursor.next().user_id, cursor.next().user_id, cursor.next()] == ["2", "3", None]


def test_real_cursor_expired_or_other_account():
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    gw.loader.context.username = "icm_tester"
    with pytest.raises(E.PilotStop) as exc:
        gw.open_followers("999", "objetivo", _frozen(time.time() - 1))
    assert exc.value.reason == E.CURSOR_EXPIRED
    with pytest.raises(E.PilotStop) as exc:
        gw.open_followers("999", "objetivo", _frozen(time.time() + 3600, username="otra"))
    assert exc.value.reason == E.CURSOR_EXPIRED


def test_details_from_node_reads_only_present_keys():
    node = {"id": "5", "username": "Clinica", "full_name": "Clínica", "is_private": False,
            "biography": "Fisioterapia", "external_url": None,
            "bio_links": [{"url": "https://wa.me/573001234567", "title": "WA"}, {"title": "sin url"}],
            "business_category_name": "Medical", "is_business_account": True,
            "business_email": "x@y.co", "public_phone_number": "", "edge_followed_by": {"count": 3}}
    d = details_from_node(node)
    assert d.username == "clinica" and d.bio_links == ["https://wa.me/573001234567"]
    assert d.contact_keys == ["business_email"]  # solo el nombre de la clave con valor
    assert not hasattr(d, "business_email")
    with pytest.raises(E.PilotStop) as exc:
        details_from_node({"id": "5", "username": "x"})
    assert exc.value.reason == E.SCHEMA_CHANGED


def test_stub_from_node():
    s = stub_from_node({"id": 12, "username": "ABC", "is_private": True})
    assert (s.user_id, s.username, s.is_private) == ("12", "abc", True)
    with pytest.raises(E.PilotStop):
        stub_from_node({"username": "x"})


@pytest.mark.parametrize(
    "exc,reason",
    [
        (ie.TooManyRequestsException("429 Too Many Requests"), E.RATE_LIMITED),
        (ie.ConnectionException("JSON Query: x") , E.CONNECTION),
        (ie.AbortDownloadException("checkpoint_required"), E.CHECKPOINT),
        (ie.ConnectionException("challenge_required"), E.CHECKPOINT),
        (ie.LoginRequiredException("login"), E.SESSION_INVALID),
        (ie.AbortDownloadException("Query to https://www.instagram.com/graphql/query responded with \"401 Unauthorized\""), E.SESSION_INVALID),
        (ie.QueryReturnedForbiddenException("403 Forbidden"), E.ACCESS_DENIED),
        (KeyError("edge_followed_by"), E.SCHEMA_CHANGED),
        (requests.exceptions.ReadTimeout("timed out"), E.CONNECTION),
    ],
)
def test_classify(exc, reason):
    assert E.classify(exc).reason == reason


def test_classify_follows_cause_chain():
    try:
        try:
            raise ie.TooManyRequestsException("429")
        except ie.TooManyRequestsException as inner:
            raise ie.ConnectionException("JSON Query to graphql/query: failed") from inner
    except ie.ConnectionException as outer:
        assert E.classify(outer).reason == E.RATE_LIMITED


def test_sanitize_hides_secrets_and_contacts():
    text = "sessionid=abc123; csrftoken: xyz Cookie=foo info@a.co +57 300 123 4567"
    out = E.sanitize(text)
    for secret in ("abc123", "xyz", "foo", "info@a.co", "300 123 4567"):
        assert secret not in out


def _gw_with_cookie(uid):
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    if uid is not None:
        gw.loader.context._session.cookies.set("ds_user_id", uid)
    return gw


def test_identity_via_test_login():
    gw = _gw_with_cookie("111")
    gw.whoami = lambda: "yo"
    assert gw.verify_identity("yo") == "test_login"
    gw.whoami = lambda: "otra"
    with pytest.raises(E.PilotStop) as exc:
        gw.verify_identity("yo")
    assert exc.value.reason == E.SESSION_INVALID


def test_identity_fallback_when_test_login_is_refused():
    from icm_ig_pilot.gateway import TargetInfo

    gw = _gw_with_cookie("111")
    gw.whoami = lambda: None  # 401 "Please wait a few minutes"
    gw.resolve_target = lambda u: TargetInfo("111", u, None, 0, False)
    assert gw.verify_identity("yo") == "session_cookie_vs_public_id"
    gw.resolve_target = lambda u: TargetInfo("222", u, None, 0, False)
    with pytest.raises(E.PilotStop) as exc:
        gw.verify_identity("yo")
    assert exc.value.reason == E.SESSION_INVALID


def test_identity_without_cookie_stops():
    gw = _gw_with_cookie(None)
    gw.whoami = lambda: None
    with pytest.raises(E.PilotStop) as exc:
        gw.verify_identity("yo")
    assert exc.value.reason == E.SESSION_INVALID


def test_session_user_id_with_empty_pre_login_cookie():
    # Igual que tras InstaloaderContext.login: cookie vacía sin dominio + la real de Instagram.
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    jar = gw.loader.context._session.cookies
    jar.set("ds_user_id", "")
    jar.set("ds_user_id", "123456", domain=".instagram.com", path="/")
    assert gw.session_user_id() == "123456"
    jar.set("ds_user_id", "999", domain="www.instagram.com", path="/")
    assert gw.session_user_id() is None  # dos cuentas distintas: no se adivina


def test_saved_session_keeps_real_cookies_not_empty_placeholders(tmp_path):
    import pickle

    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    jar = gw.loader.context._session.cookies
    jar.clear()
    for name in ("sessionid", "ds_user_id", "csrftoken"):
        jar.set(name, "")  # como en InstaloaderContext.login, antes de autenticar
    jar.set("sessionid", "SECRETO", domain=".instagram.com", path="/")
    jar.set("ds_user_id", "123", domain=".instagram.com", path="/")
    gw.loader.context.username = "yo"
    assert gw.prepare_session_for_saving() is True
    path = tmp_path / "s"
    gw.loader.save_session_to_file(str(path))
    saved = pickle.load(open(path, "rb"))
    assert saved["sessionid"] == "SECRETO" and saved["ds_user_id"] == "123"


def test_no_session_cookie_is_not_saved():
    gw = InstaloaderGateway(Guard(deadline=time.monotonic() + 60))
    jar = gw.loader.context._session.cookies
    jar.clear()
    jar.set("sessionid", "")
    jar.set("ds_user_id", "123", domain=".instagram.com", path="/")
    assert gw.prepare_session_for_saving() is False
