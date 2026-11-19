import csv
import io
import json

from icm_ig_pilot.gateway import Guard
from icm_ig_pilot.pipeline import Pipeline
from icm_ig_pilot.report import csv_safe, write_outputs
from icm_ig_pilot.store import Store

from .fakes import FakeGateway, follower, profile

BIO = 'Clínica "Ñandú"\n=SUMA(A1)\ncontacto: +57 300 123 4567 · 6044445566 · -menos@x.co'


def run_with(tmp_path):
    store = Store(tmp_path / "r" / "pilot.sqlite")
    store.create_run(run_id="r", target_input="t", target_username="t", target_userid="9", target_full_name=None,
                     target_followers_count=2, session_username="s", limit_total=10, include_web=False)
    store.begin_session()
    gw = FakeGateway([follower(1), follower(2, private=True)], {"1": profile(1, bio=BIO, contact_keys=["business_email"])})
    Pipeline(store, gw, Guard(deadline=1e12)).execute()
    return store, write_outputs(store, tmp_path / "r")


def test_csv_safe_cells():
    assert csv_safe("=1+1") == "'=1+1"
    assert csv_safe("+573001234567", "e164") == "'+573001234567"
    assert csv_safe("@SUM(A1)") == "'@SUM(A1)"
    assert csv_safe("-2") == "'-2"
    assert csv_safe("3001234567", "normalized") == "'3001234567"
    assert csv_safe("Ñandú \"x\"\nlínea") == "Ñandú \"x\"\nlínea"
    assert csv_safe(None) == ""
    assert csv_safe("a\x00b") == "ab"


def test_contacts_csv_roundtrip_is_safe(tmp_path):
    _store, paths = run_with(tmp_path)
    raw = open(paths["contacts"], "rb").read()
    assert raw.startswith(b"\xef\xbb\xbf")  # BOM para Excel
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    assert {r["kind"] for r in rows} == {"phone", "email"}
    for r in rows:
        for value in r.values():
            assert not value.startswith(("=", "+", "-", "@"))
    phones = {r["normalized"] for r in rows if r["kind"] == "phone"}
    assert phones == {"'+573001234567", "'6044445566"}
    evidence = [r["evidence"] for r in rows]
    assert any("Ñandú" in e or "contacto" in e for e in evidence)


def test_outputs_and_report_have_no_contact_values(tmp_path):
    _store, paths = run_with(tmp_path)
    report = open(paths["report"], encoding="utf-8").read()
    log = open(paths["log"], encoding="utf-8").read()
    summary = json.load(open(paths["summary"], encoding="utf-8"))
    for text in (report, log, json.dumps(summary)):
        assert "3001234567" not in text and "menos@x.co" not in text and "SUMA" not in text
    assert summary["paid_dependencies"] == "ninguna"
    assert summary["counters"]["private_skipped"] == 1
    assert summary["counters"]["public_consulted"] == 1
    assert summary["contact_buttons"]["exposed_by_instaloader"] is False
    assert summary["contact_buttons"]["keys_with_value"] == {"business_email": 1}
    recs = [json.loads(line) for line in open(paths["followers"], encoding="utf-8")]
    priv = next(r for r in recs if r["user_id"] == "2")
    assert priv["full_name"] is None and priv["biography"] is None and priv["contacts_status"] == "private_skipped"
