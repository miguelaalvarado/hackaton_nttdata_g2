"""Tres escenarios: riesgo bajo, medio y alto (datos ficticios)."""


def _post(client, payload):
    r = client.post("/v1/decisions", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def _assert_invariants(d):
    assert d["delivery"] == {"sent": False, "mode": "draft_only", "note": d["delivery"]["note"]}
    assert d["compliance"]["human_approval_required"] is True
    assert d["review_status"] == "pending"
    assert d["compliance"]["status"] == "pending_human_approval", d["compliance"]["violations"]


def test_low_risk(client, make_request):
    d = _post(client, make_request())
    _assert_invariants(d)
    assert d["interpretation"]["band"] == "low"
    assert d["strategy"]["code"] == "friendly_reminder"
    assert d["strategy"]["proposed_offers"] == []
    assert d["interpretation"]["evidence"], "debe citar evidencia"
    assert "Lucía" in d["message"]["body"]


def test_medium_risk(client, make_request):
    d = _post(client, make_request(**{
        "risk_score.value": 50,
        "behavior.missed_payments_last_6m": 1,
        "behavior.on_time_payment_ratio_6m": 0.75,
        "behavior.credit_utilization": 0.6,
        "behavior.payment_trend": "stable",
    }))
    _assert_invariants(d)
    assert d["interpretation"]["band"] == "medium"
    assert d["strategy"]["code"] == "proactive_support"
    assert d["strategy"]["channel"] == "whatsapp"
    assert any("sujeta a evaluación" in o for o in d["strategy"]["proposed_offers"])


def test_high_risk(client, make_request):
    d = _post(client, make_request(**{
        "risk_score.value": 85,
        "behavior.missed_payments_last_6m": 3,
        "behavior.on_time_payment_ratio_6m": 0.4,
        "behavior.credit_utilization": 0.95,
        "behavior.payment_trend": "worsening",
    }))
    _assert_invariants(d)
    assert d["interpretation"]["band"] == "high"
    assert d["interpretation"]["confidence"] == "high"
    assert d["strategy"]["code"] == "advisor_outreach"
    assert d["strategy"]["channel"] == "phone_call"
    assert "ahora mismo" not in d["message"]["body"].lower()
