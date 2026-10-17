"""Límites de bandas (umbrales ilustrativos 35/65) y reglas de calendario/zona horaria por canal."""
import pytest

from app.calendar_pe import holiday_name, is_business_day
from app.interpreter import band_for


@pytest.mark.parametrize("score,band", [
    (0, "low"), (34.99, "low"), (35, "medium"), (50, "medium"), (65, "medium"),
    (65.01, "high"), (100, "high"),
])
def test_band_boundaries(score, band):
    assert band_for(score).value == band


@pytest.mark.parametrize("score", [-0.01, 100.01])
def test_score_range_rejected(client, make_request, score):
    assert client.post("/v1/decisions", json=make_request(**{"risk_score.value": score})).status_code == 422


def test_response_declares_score_is_illustrative(client, make_request):
    d = client.post("/v1/decisions", json=make_request()).json()
    assert "no es una probabilidad validada" in d["interpretation"]["score_note"]


def test_holidays_and_business_days():
    import datetime as dt
    assert holiday_name(dt.date(2026, 4, 2)) == "Jueves Santo"
    assert holiday_name(dt.date(2026, 4, 3)) == "Viernes Santo"
    assert holiday_name(dt.date(2026, 10, 8)) == "Combate de Angamos"
    assert not is_business_day(dt.date(2026, 10, 10))  # sábado
    assert is_business_day(dt.date(2026, 11, 3))       # martes


def _post(client, make_request, channel, contact_at):
    return client.post("/v1/decisions", json=make_request(**{
        "customer.preferred_channel": channel, "contact_at": contact_at,
        "customer.contact_consent": ["sms", "email", "whatsapp", "push", "phone_call", "in_person_visit"],
    })).json()


def _failed(d):
    return {c["rule_id"] for c in d["compliance"]["checks"] if not c["passed"]}


@pytest.mark.parametrize("channel", ["phone_call", "in_person_visit"])
def test_calls_and_visits_blocked_on_weekend_and_holiday(client, make_request, channel):
    sat = _post(client, make_request, channel, "2026-10-10T10:00:00-05:00")
    assert "C09" in _failed(sat) and sat["compliance"]["status"] == "blocked_needs_rewrite"
    hol = _post(client, make_request, channel, "2026-10-08T10:00:00-05:00")
    assert "C10" in _failed(hol)
    ok = _post(client, make_request, channel, "2026-11-03T10:00:00-05:00")
    assert ok["compliance"]["status"] == "pending_human_approval"


def test_digital_channels_not_restricted_by_day(client, make_request):
    d = _post(client, make_request, "sms", "2026-10-10T10:00:00-05:00")  # sábado
    assert d["compliance"]["status"] == "pending_human_approval"


@pytest.mark.parametrize("channel", ["sms", "phone_call"])
@pytest.mark.parametrize("contact_at,ok", [
    ("2026-11-03T07:59:00-05:00", False), ("2026-11-03T08:00:00-05:00", True),
    ("2026-11-03T19:59:00-05:00", True), ("2026-11-03T20:00:00-05:00", False),
])
def test_hour_window_edges_all_channels(client, make_request, channel, contact_at, ok):
    d = _post(client, make_request, channel, contact_at)
    assert ("C02" not in _failed(d)) is ok


def test_timezone_is_converted_to_lima(client, make_request):
    # 12:00Z = 07:00 Lima -> fuera de ventana; 16:00Z = 11:00 Lima -> dentro
    early = _post(client, make_request, "sms", "2026-11-03T12:00:00+00:00")
    assert "C02" in _failed(early) and early["strategy"]["contact_hour"] == 7
    ok = _post(client, make_request, "sms", "2026-11-03T16:00:00+00:00")
    assert "C02" not in _failed(ok) and ok["strategy"]["contact_timezone"] == "America/Lima"
    # 01:30Z del día 4 = 20:30 Lima del día 3 (cruce de fecha)
    late = _post(client, make_request, "phone_call", "2026-11-04T01:30:00+00:00")
    assert late["strategy"]["contact_date"] == "2026-11-03" and "C02" in _failed(late)


def test_naive_contact_at_rejected(client, make_request):
    assert client.post("/v1/decisions", json=make_request(contact_at="2026-11-03T10:00:00")).status_code == 422
