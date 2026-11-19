from pathlib import Path

import pytest

from icm_ig_pilot import cli


def test_run_rejects_bad_target_before_any_query(capsys):
    assert cli.main(["run", "--target", "https://www.instagram.com/p/abc/", "--user", "yo"]) == cli.EXIT_USAGE
    assert "rechazado" in capsys.readouterr().err


def test_limit_above_300_is_rejected():
    with pytest.raises(SystemExit, match="300"):
        cli.main(["run", "--target", "perfil", "--user", "yo", "--limit", "301"])


def test_paths_inside_repo_are_rejected():
    repo = Path(cli.__file__).resolve().parents[3]
    with pytest.raises(SystemExit, match="fuera del repositorio"):
        cli.ensure_outside_repo(repo / "tools" / "out", "La carpeta de salida")


def test_missing_session_explains_login(tmp_path):
    with pytest.raises(SystemExit, match="login"):
        cli.main(["run", "--target", "perfil", "--user", "yo", "--session-file", str(tmp_path / "nada")])


def test_single_instance_lock():
    with cli.single_instance():
        with pytest.raises(SystemExit) as exc:
            with cli.single_instance():
                pass
        assert exc.value.code == cli.EXIT_BUSY


def test_state_root_is_outside_repo():
    repo = Path(cli.__file__).resolve().parents[3]
    assert repo not in cli.state_root().resolve().parents


def test_report_without_run(tmp_path, capsys):
    assert cli.main(["report", "--run-dir", str(tmp_path)]) == cli.EXIT_USAGE


def _answers(monkeypatch, values):
    it = iter(values)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": next(it))


def test_pasted_cookies_are_verified_and_saved(monkeypatch, tmp_path, capsys):
    import pickle

    from icm_ig_pilot.gateway import InstaloaderGateway

    monkeypatch.setattr(InstaloaderGateway, "verify_identity", lambda self, user: "test_login")
    _answers(monkeypatch, ["123%3AabcDEF%3A28%3AAYd", "csrfTOKENvalue12", "123"])
    path = tmp_path / "sesion"
    assert cli.main(["login", "--user", "yo", "--paste-sessionid", "--session-file", str(path)]) == cli.EXIT_OK
    saved = pickle.load(open(path, "rb"))
    assert saved["sessionid"] == "123%3AabcDEF%3A28%3AAYd" and saved["ds_user_id"] == "123"
    out = capsys.readouterr()
    assert "abcDEF" not in out.out + out.err and "csrfTOKEN" not in out.out + out.err


def test_pasted_cookies_wrong_account_not_saved(monkeypatch, tmp_path):
    from icm_ig_pilot.errors import SESSION_INVALID, PilotStop
    from icm_ig_pilot.gateway import InstaloaderGateway

    def other(self, user):
        raise PilotStop(SESSION_INVALID, "otra cuenta")

    monkeypatch.setattr(InstaloaderGateway, "verify_identity", other)
    _answers(monkeypatch, ["123%3AabcDEF%3A28%3AAYd", "csrfTOKENvalue12", "123"])
    path = tmp_path / "sesion"
    assert cli.main(["login", "--user", "yo", "--paste-sessionid", "--session-file", str(path)]) == cli.EXIT_STOPPED
    assert not path.exists()


def test_pasted_cookie_with_bad_format_stops_before_any_query(monkeypatch, tmp_path):
    _answers(monkeypatch, ["no válido con espacios"])
    path = tmp_path / "sesion"
    assert cli.main(["login", "--user", "yo", "--paste-sessionid", "--session-file", str(path)]) == cli.EXIT_STOPPED
    assert not path.exists()
