import pytest

from icm_ig_pilot.url import TargetError, canonical_profile_url, parse_target


@pytest.mark.parametrize(
    "value",
    [
        "https://www.instagram.com/clinica.ejemplo/",
        "https://instagram.com/clinica.ejemplo",
        "http://www.instagram.com/clinica.ejemplo/",
        "https://m.instagram.com/clinica.ejemplo/",
        "https://www.instagram.com/Clinica.Ejemplo/?igsh=abc123&utm_source=qr",
        "https://www.instagram.com/clinica.ejemplo/#top",
        "www.instagram.com/clinica.ejemplo/",
        "instagram.com/clinica.ejemplo",
        "clinica.ejemplo",
        "@Clinica.Ejemplo",
        "  clinica.ejemplo  ",
        "https://WWW.INSTAGRAM.COM./clinica.ejemplo",
    ],
)
def test_accepts_profile_forms(value):
    assert parse_target(value) == "clinica.ejemplo"


@pytest.mark.parametrize(
    "value",
    [
        "https://instagram.com.evil.co/clinica",  # dominio parecido
        "https://instagrarn.com/clinica",
        "https://www.instagram.co/clinica",
        "https://xn--nstagram-q0a.com/clinica",
        "https://evil.com/instagram.com/clinica",
        "evil.com/clinica",
        "https://user:pass@www.instagram.com/clinica/",  # credenciales
        "https://www.instagram.com@evil.com/clinica/",
        "ftp://www.instagram.com/clinica/",  # protocolo
        "javascript:alert(1)",
        "file:///C:/clinica",
        "https://www.instagram.com:8443/clinica/",
        "https://www.instagram.com/p/C1a2b3c4d5/",  # publicación
        "https://www.instagram.com/reel/C1a2b3c4d5/",
        "https://www.instagram.com/reels/C1a2b3c4d5/",
        "https://www.instagram.com/tv/C1a2b3c4d5/",
        "https://www.instagram.com/stories/clinica/123456/",
        "https://www.instagram.com/explore/tags/salud/",
        "https://www.instagram.com/clinica/followers/",
        "https://www.instagram.com/clinica/p/abc/",
        "https://www.instagram.com/",
        "https://www.instagram.com/accounts/login/",
        "",
        "   ",
        "clinica ejemplo",
        ".clinica",
        "clinica.",
        "cli..nica",
        "a" * 31,
        "clínica",
        "explore",
    ],
)
def test_rejects(value):
    with pytest.raises(TargetError):
        parse_target(value)


def test_canonical_url():
    assert canonical_profile_url("clinica.ejemplo") == "https://www.instagram.com/clinica.ejemplo/"
