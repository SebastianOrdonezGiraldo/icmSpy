import json

import pytest

from icm_ig_pilot import errors as E
from icm_ig_pilot.gateway import Guard
from icm_ig_pilot.pipeline import Pipeline
from icm_ig_pilot.store import ENRICHED, FAILED, INACCESSIBLE, PENDING, PRIVATE_SKIPPED, Store

from .fakes import FakeGateway, PilotStop, ProfileFailed, ProfileUnavailable, follower, profile


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make(tmp_path, followers, profiles=None, limit=100, fail_hook=None, web=False):
    store = Store(tmp_path / "run" / "pilot.sqlite", fail_hook=fail_hook)
    store.create_run(run_id="run", target_input="objetivo", target_username="objetivo", target_userid="999",
                     target_full_name=None, target_followers_count=len(followers), session_username="icm_tester",
                     limit_total=limit, include_web=web)
    store.begin_session()
    gw = FakeGateway(followers, profiles)
    clock = Clock()
    guard = Guard(deadline=10_000, clock=clock, sleeper=clock.sleep)
    return store, gw, guard


def statuses(store):
    return dict(store.db.execute("SELECT user_id, status FROM followers").fetchall())


def test_collects_and_enriches_until_list_ends(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)])
    out = Pipeline(store, gw, guard).execute()
    assert (out.status, out.reason) == ("completed", E.FOLLOWERS_EXHAUSTED)
    assert set(statuses(store).values()) == {ENRICHED}
    run = store.get_run()
    assert (run.rows_received, run.duplicates, run.cursor_exhausted) == (5, 0, True)


def test_limit_counts_unique_followers(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 50)], limit=10)
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.LIMIT_REACHED
    assert store.unique_followers() == 10


def test_duplicates_across_pages_are_counted_not_stored_twice(tmp_path):
    rows = [follower(1), follower(2), follower(2), follower(3), follower(1)]
    store, gw, guard = make(tmp_path, rows)
    Pipeline(store, gw, guard).execute()
    run = store.get_run()
    assert store.unique_followers() == 3
    assert (run.rows_received, run.duplicates) == (5, 2)
    assert [c for c in gw.calls if c[0] == "profile"] == [("profile", "1"), ("profile", "2"), ("profile", "3")]


def test_username_change_same_id_is_one_follower(tmp_path):
    rows = [follower(7, username="viejo_nombre"), follower(7, username="nuevo_nombre")]
    store, gw, guard = make(tmp_path, rows, {"7": profile(7, username="nuevo_nombre")})
    Pipeline(store, gw, guard).execute()
    assert store.unique_followers() == 1
    row = store.db.execute("SELECT username FROM followers").fetchone()
    assert row["username"] == "nuevo_nombre"
    history = [r[0] for r in store.db.execute("SELECT username FROM username_history ORDER BY username")]
    assert history == ["nuevo_nombre", "viejo_nombre"]


def test_private_follower_is_minimal_and_never_queried(tmp_path):
    store, gw, guard = make(tmp_path, [follower(1, private=True), follower(2)])
    Pipeline(store, gw, guard).execute()
    assert statuses(store) == {"1": PRIVATE_SKIPPED, "2": ENRICHED}
    assert ("profile", "1") not in gw.calls
    row = store.db.execute("SELECT * FROM followers WHERE user_id='1'").fetchone()
    assert row["full_name"] is None and row["biography"] is None


def test_profile_turned_private_stores_no_content(tmp_path):
    store, gw, guard = make(tmp_path, [follower(1)], {"1": profile(1, bio="info@a.co", private=True)})
    Pipeline(store, gw, guard).execute()
    row = store.db.execute("SELECT * FROM followers").fetchone()
    assert row["status"] == PRIVATE_SKIPPED and row["biography"] is None
    assert store.db.execute("SELECT count(*) FROM contacts").fetchone()[0] == 0


def test_no_contacts_vs_not_consulted(tmp_path):
    from icm_ig_pilot.report import write_followers_jsonl

    gw_profiles = {"1": profile(1, bio="Fisioterapia deportiva"), "2": ProfileFailed("timeout")}
    store, gw, guard = make(tmp_path, [follower(1), follower(2)], gw_profiles)
    Pipeline(store, gw, guard).execute()
    path = tmp_path / "f.jsonl"
    write_followers_jsonl(store, path)
    recs = {r["user_id"]: r for r in map(json.loads, path.read_text(encoding="utf-8").splitlines())}
    assert recs["1"]["contacts_status"] == "none_found"
    assert recs["2"]["contacts_status"] == FAILED


def test_profile_contacts_with_provenance(tmp_path):
    p = profile(1, bio="Citas: citas@fisio.co · +57 300 123 4567", external_url="https://wa.me/573001234567",
                bio_links=["https://wa.me/573001234567", "mailto:otra@fisio.co"])
    store, gw, guard = make(tmp_path, [follower(1)], {"1": p})
    Pipeline(store, gw, guard).execute()
    rows = store.db.execute("SELECT kind, normalized, e164, status, source, field, source_url, attribution, "
                            "evidence FROM contacts ORDER BY id").fetchall()
    got = {(r["kind"], r["normalized"], r["field"]) for r in rows}
    assert got == {
        ("email", "citas@fisio.co", "biography"),
        ("phone", "+573001234567", "biography"),
        ("whatsapp", "+573001234567", "external_url"),
        ("email", "otra@fisio.co", "bio_links"),
    }
    for r in rows:
        assert r["source"] == "instagram_profile"
        assert r["source_url"] == "https://www.instagram.com/user1/"
        assert r["attribution"] == "profile_owner"
        assert r["evidence"]


def test_same_contact_in_several_profiles(tmp_path):
    from icm_ig_pilot.report import contact_stats

    profiles = {"1": profile(1, bio="info@red.co"), "2": profile(2, bio="INFO@red.co")}
    store, gw, guard = make(tmp_path, [follower(1), follower(2)], profiles)
    Pipeline(store, gw, guard).execute()
    stats = contact_stats(store)
    assert stats["observations"] == 2 and stats["unique_values"] == 1
    assert stats["values_in_several_profiles"] == 1


def test_inaccessible_profile_does_not_stop(tmp_path):
    store, gw, guard = make(tmp_path, [follower(1), follower(2)], {"1": ProfileUnavailable("404")})
    out = Pipeline(store, gw, guard).execute()
    assert out.status == "completed"
    assert statuses(store) == {"1": INACCESSIBLE, "2": ENRICHED}


def test_access_denied_stops_and_keeps_progress(tmp_path):
    profiles = {"3": PilotStop(E.ACCESS_DENIED, "403")}
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)], profiles)
    out = Pipeline(store, gw, guard).execute()
    assert (out.status, out.reason) == ("stopped", E.ACCESS_DENIED)
    assert statuses(store) == {"1": ENRICHED, "2": ENRICHED, "3": PENDING}
    assert store.get_run().stop_reason == E.ACCESS_DENIED


def test_429_while_listing_stops_saves_and_resumes_without_duplicates(tmp_path):
    rows = [follower(i) for i in range(1, 8)]
    store, gw, guard = make(tmp_path, rows)
    gw.cursor_errors[4] = PilotStop(E.RATE_LIMITED, "HTTP 429")
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.RATE_LIMITED
    assert store.unique_followers() == 4
    assert store.get_run().cursor_state == {"index": 3, "user": "icm_tester"}

    store.begin_session()
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.FOLLOWERS_EXHAUSTED
    run = store.get_run()
    assert store.unique_followers() == 7
    # El último elemento que repite el cursor reanudado no cuenta como fila nueva ni duplicado.
    assert (run.rows_received, run.duplicates) == (7, 0)
    assert [c for c in gw.calls if c[0] == "open"][1] == ("open", {"index": 3, "user": "icm_tester"})


def test_429_on_profile_leaves_follower_pending_for_resume(tmp_path):
    store, gw, guard = make(tmp_path, [follower(1), follower(2), follower(3)],
                            {"2": PilotStop(E.RATE_LIMITED, "429")})
    Pipeline(store, gw, guard).execute()
    assert statuses(store)["2"] == PENDING
    gw.profiles.pop("2")
    store.begin_session()
    out = Pipeline(store, gw, guard).execute()
    assert out.status == "completed"
    assert set(statuses(store).values()) == {ENRICHED}
    assert [c[1] for c in gw.calls if c[0] == "profile"].count("2") == 2


def test_interrupt_then_resume(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 10)])

    class Interrupting(FakeGateway):
        pass

    original = gw.fetch_profile

    def fetch(stub):
        if stub.user_id == "4":
            guard.stop_requested = True  # Ctrl+C mientras se consultaba el perfil 4
        return original(stub)

    gw.fetch_profile = fetch
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.INTERRUPTED
    assert store.unique_followers() == 4 and statuses(store)["4"] == ENRICHED

    guard.stop_requested = False
    gw.fetch_profile = original
    store.begin_session()
    out = Pipeline(store, gw, guard).execute()
    assert out.status == "completed" and store.unique_followers() == 9
    assert store.get_run().duplicates == 0


def test_failure_before_save_rolls_back_and_item_is_reread(tmp_path):
    state = {"fail": True}

    def hook(point):
        if point == "follower_saved" and state["fail"] and hook.count == 2:
            raise RuntimeError("corte simulado antes de guardar el cursor")
        if point == "follower_saved":
            hook.count += 1

    hook.count = 0
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 5)], fail_hook=hook)
    with pytest.raises(RuntimeError):
        Pipeline(store, gw, guard).execute()
    # El seguidor 3 no quedó a medias: ni fila ni cursor avanzado.
    assert store.unique_followers() == 2
    assert store.get_run().cursor_state == {"index": 1, "user": "icm_tester"}
    assert store.get_run().status == "error"

    state["fail"] = False
    store.begin_session()
    Pipeline(store, gw, guard).execute()
    assert store.unique_followers() == 4 and store.get_run().duplicates == 0


def test_failure_after_save_does_not_duplicate(tmp_path):
    calls = {"n": 0}
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 5)])
    original = gw.fetch_profile

    def fetch(stub):
        calls["n"] += 1
        if calls["n"] == 2:
            raise PilotStop(E.CONNECTION, "red caída justo después de guardar el seguidor 2")
        return original(stub)

    gw.fetch_profile = fetch
    Pipeline(store, gw, guard).execute()
    assert store.unique_followers() == 2 and statuses(store)["2"] == PENDING
    store.begin_session()
    Pipeline(store, gw, guard).execute()
    run = store.get_run()
    assert store.unique_followers() == 4 and (run.rows_received, run.duplicates) == (4, 0)
    assert set(statuses(store).values()) == {ENRICHED}


def test_repeated_profile_failures_stop(tmp_path):
    profiles = {str(i): ProfileFailed("timeout") for i in range(1, 6)}
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)], profiles)
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.REPEATED_FAILURES
    assert list(statuses(store).values()).count(FAILED) == 3


def test_time_limit_stops(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)])
    original = gw.fetch_profile

    def slow(stub):
        guard._clock.t += 4000  # cada perfil "tarda" 4000 s
        return original(stub)

    gw.fetch_profile = slow
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.TIME_LIMIT
    assert 1 <= store.unique_followers() < 5


def test_cursor_expired_is_reported(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)])
    gw.cursor_errors[2] = PilotStop(E.CONNECTION, "red")
    Pipeline(store, gw, guard).execute()
    gw.expired = True
    store.begin_session()
    out = Pipeline(store, gw, guard).execute()
    assert out.reason == E.CURSOR_EXPIRED
    # Reinicio explícito del cursor: relee desde el inicio y descarta repetidos por ID.
    gw.expired = False
    store.reset_cursor()
    store.begin_session()
    out = Pipeline(store, gw, guard).execute()
    run = store.get_run()
    assert out.status == "completed" and store.unique_followers() == 5
    assert run.duplicates == 2 and run.cursor_generation == 2


def test_cursor_for_other_session_is_rejected(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 6)])
    gw.cursor_errors[2] = PilotStop(E.CONNECTION, "red")
    Pipeline(store, gw, guard).execute()
    gw.session_user = "otra_cuenta"
    store.begin_session()
    assert Pipeline(store, gw, guard).execute().reason == E.CURSOR_EXPIRED


def test_schema_change_stops(tmp_path):
    store, gw, guard = make(tmp_path, [follower(1), follower(2)],
                            {"2": PilotStop(E.SCHEMA_CHANGED, "perfil sin claves")})
    assert Pipeline(store, gw, guard).execute().reason == E.SCHEMA_CHANGED


def test_cumulative_limit_with_resume(tmp_path):
    store, gw, guard = make(tmp_path, [follower(i) for i in range(1, 400)], limit=100)
    assert Pipeline(store, gw, guard).execute().reason == E.LIMIT_REACHED
    store.begin_session(limit_total=300)
    assert Pipeline(store, gw, guard).execute().reason == E.LIMIT_REACHED
    assert store.unique_followers() == 300
    store.begin_session()
    Pipeline(store, gw, guard).execute()
    assert store.unique_followers() == 300  # nunca más de 300 acumulados


def test_existing_run_folder_refuses_new_run(tmp_path):
    store, _gw, _guard = make(tmp_path, [])
    with pytest.raises(Exception, match="ya contiene"):
        store.create_run(run_id="x", target_input="a", target_username="a", target_userid="1",
                         target_full_name=None, target_followers_count=0, session_username="s",
                         limit_total=1, include_web=False)
