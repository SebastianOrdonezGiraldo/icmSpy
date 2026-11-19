import pytest

from icm_ig_pilot import contacts as C


def emails(text):
    return [c.normalized for c in C.extract_emails(text)]


def phones(text):
    found, rejected = C.extract_from_text(text)
    return [c for c in found if c.kind == "phone"], rejected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Escríbenos: info@clinica.com.", ["info@clinica.com"]),
        ("(ventas@ejemplo.co)", ["ventas@ejemplo.co"]),
        ("correo:a@b.com,c.d@e.com.co;", ["a@b.com", "c.d@e.com.co"]),
        ("«Citas@Clinica-Ejemplo.COM»", ["citas@clinica-ejemplo.com"]),
        ("📧 contacto@fisio.co ✨", ["contacto@fisio.co"]),
        ("Info＠ejemplo.com", ["info@ejemplo.com"]),  # arroba de ancho completo
        ("first.last+tag@sub.dominio.org!", ["first.last+tag@sub.dominio.org"]),
    ],
)
def test_emails_with_punctuation(text, expected):
    assert emails(text) == expected


@pytest.mark.parametrize(
    "text",
    ["logo@2x.png", "contacto..mal@x.com", ".a@b.com", "a@b", "info (at) clinica (dot) com", "@clinica"],
)
def test_not_emails_and_no_deobfuscation(text):
    assert emails(text) == []


def test_never_builds_email_from_name_or_domain():
    found, _ = C.extract_from_text("Clínica Ejemplo · www.clinicaejemplo.com")
    assert [c for c in found if c.kind == "email"] == []


def test_international_phone_is_e164_only_with_plus():
    found, _ = phones("WhatsApp +57 300 123 4567 · Londres +44 20 7946 0958")
    assert [(c.e164, c.status) for c in found] == [
        ("+573001234567", C.PHONE_E164),
        ("+442079460958", C.PHONE_E164),
    ]


def test_bare_number_stays_ambiguous_without_country():
    found, _ = phones("Citas al 300 123 4567")
    assert len(found) == 1
    c = found[0]
    assert c.status == C.PHONE_AMBIGUOUS
    assert c.e164 is None
    assert c.normalized == "3001234567"  # no se asigna +57


def test_00_prefix_is_not_converted():
    found, _ = phones("Llame al 0057 300 1234567")
    assert found[0].status == C.PHONE_AMBIGUOUS and found[0].e164 is None


def test_invalid_international_kept_unverified():
    found, _ = phones("+99 123 4567 890")
    assert found[0].status == C.PHONE_INTL_UNVERIFIED and found[0].e164 is None


@pytest.mark.parametrize(
    "text,ext",
    [
        ("+1 (415) 555-2671 x 33", "33"),
        ("PBX 604 444 5566 ext. 120", "120"),
        ("601 765 4321 extensión 7", "7"),
        ("+57 604 444 5566 opción 2", "2"),
    ],
)
def test_extensions(text, ext):
    found, _ = phones(text)
    assert found[0].extension == ext


def test_joined_numbers_are_split():
    found, _ = phones("Citas 3001234567 - 3107654321")
    assert [c.normalized for c in found] == ["3001234567", "3107654321"]


@pytest.mark.parametrize(
    "text,reason",
    [
        ("NIT 900.123.456-7", "identifier"),
        ("NIT: 9001234567", "identifier"),
        ("C.C. 1.020.304.050", "identifier"),
        ("Registro INVIMA 2019012345", "identifier"),
        ("Desde 2019-2024", "year_range"),
        ("Precio $ 1.500.000", "money"),
        ("1250000 COP", "money"),
        ("Cita 2024-05-15", "date"),
        ("Cita 15.05.2024", "date"),
        ("Total 1.234.567", "identifier_or_amount"),
        ("Cód. 1234567", "identifier"),
    ],
)
def test_non_phones_are_rejected(text, reason):
    found, rejected = phones(text)
    assert found == []
    assert reason in [r.reason for r in rejected]


@pytest.mark.parametrize("text", ["Horario 8:00-17:00", "Calle 45 # 10-23 piso 3", "15/05/2024", "20% dto", "Sede 2"])
def test_short_or_non_numeric_noise(text):
    found, _ = phones(text)
    assert found == []


def test_whatsapp_links():
    [c] = C.extract_from_url("https://wa.me/573001234567?text=hola")
    assert (c.kind, c.e164, c.status, c.method) == ("whatsapp", "+573001234567", C.PHONE_E164, "whatsapp_link")
    [c] = C.extract_from_url("https://api.whatsapp.com/send?phone=+57%20300%20123%204567")
    assert c.e164 == "+573001234567"
    [c] = C.extract_from_url("https://wa.me/message/ABCDEF123")
    assert c.status == C.WA_WITHOUT_NUMBER and c.normalized is None
    [c] = C.extract_from_url("wa.me/3001234567")  # sin indicativo: no se valida como E.164
    assert c.e164 is None and c.status == C.PHONE_INTL_UNVERIFIED


def test_mailto_and_tel():
    [c] = C.extract_from_url("mailto:Ventas@Ejemplo.com?subject=Hola")
    assert (c.kind, c.normalized, c.method) == ("email", "ventas@ejemplo.com", "mailto")
    [c] = C.extract_from_url("tel:+573001234567;ext=4")
    assert (c.e164, c.extension, c.method) == ("+573001234567", "4", "tel")
    [c] = C.extract_from_url("tel:6044445566")
    assert c.status == C.PHONE_AMBIGUOUS and c.e164 is None
    assert C.extract_from_url("https://clinica.example/contacto") == []


def test_whatsapp_link_in_text_not_double_counted_as_phone():
    found, _ = C.extract_from_text("Escríbenos wa.me/573001234567")
    assert [(c.kind, c.normalized) for c in found] == [("whatsapp", "+573001234567")]


def test_dedupe_within_text():
    found, _ = C.extract_from_text("info@a.co info@a.co INFO@A.CO")
    assert len([c for c in found if c.kind == "email"]) == 1
