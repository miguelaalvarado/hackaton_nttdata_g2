import pytest

from app.compliance import review
from app.schemas import DecisionRequest, DraftMessage
from app import interpreter, strategy


@pytest.mark.parametrize("key", ["age", "edad", "gender", "religion", "Estado Civil", "nacionalidad", "salud"])
def test_sensitive_attributes_rejected_top_level_and_nested(client, make_request, key):
    top = make_request()
    top[key] = "x"
    assert client.post("/v1/decisions", json=top).status_code == 422
    nested = make_request()
    nested["customer"][key] = "x"
    r = client.post("/v1/decisions", json=nested)
    assert r.status_code == 422


def test_unknown_fields_rejected(client, make_request):
    p = make_request()
    p["hack"] = 1
    assert client.post("/v1/decisions", json=p).status_code == 422


def test_score_out_of_range(client, make_request):
    assert client.post("/v1/decisions", json=make_request(**{"risk_score.value": 140})).status_code == 422


def test_no_consented_channel_blocks(client, make_request):
    r = client.post("/v1/decisions", json=make_request(**{"customer.contact_consent": []}))
    d = r.json()
    assert d["compliance"]["status"] == "blocked_needs_rewrite"
    assert d["message"]["channel"] is None
    rid = d["decision_id"]
    rv = client.post(f"/v1/decisions/{rid}/review", json={"reviewer_id": "h1", "action": "approve"})
    assert rv.status_code == 409


def test_contact_hour_outside_window_blocks(client, make_request):
    d = client.post("/v1/decisions", json=make_request(local_hour=22)).json()
    assert d["compliance"]["status"] == "blocked_needs_rewrite"
    assert any(v.startswith("C02") for v in d["compliance"]["violations"])


def test_supervisor_flags_threats_sensitive_and_guarantees(make_request):
    req = DecisionRequest.model_validate(make_request())
    strat = strategy.select_strategy(req, interpreter.interpret(req))
    bad = DraftMessage(channel=strat.channel, language="es",
                       body="Último aviso: haremos un embargo y te reportaremos a centrales de riesgo. "
                            "Por tu edad y religión, refinanciamiento garantizado.")
    rep = review(req, strat, bad)
    failed = {c.rule_id for c in rep.checks if not c.passed}
    assert {"C03", "C04", "C05", "C06"} <= failed
    assert rep.status == "blocked_needs_rewrite"
    assert rep.human_approval_required is True


def test_inconsistent_score_lowers_confidence(client, make_request):
    d = client.post("/v1/decisions", json=make_request(**{"risk_score.value": 90})).json()
    assert d["interpretation"]["band"] == "high"
    assert d["interpretation"]["confidence"] == "low"
    assert d["interpretation"]["inconsistencies"]


def test_human_review_flow_never_sends(client, make_request):
    d = client.post("/v1/decisions", json=make_request()).json()
    rid = d["decision_id"]
    ok = client.post(f"/v1/decisions/{rid}/review", json={"reviewer_id": "analista-1", "action": "approve"})
    assert ok.status_code == 200
    assert ok.json()["delivery"]["sent"] is False
    assert client.get(f"/v1/decisions/{rid}").json()["review_status"] == "approved"
    again = client.post(f"/v1/decisions/{rid}/review", json={"reviewer_id": "a", "action": "reject"})
    assert again.status_code == 409
    assert client.post("/v1/decisions/nope/review", json={"reviewer_id": "a", "action": "approve"}).status_code == 404


def test_codebase_has_no_outbound_sending():
    import pathlib, re
    src = "\n".join(p.read_text() for p in pathlib.Path("app").glob("*.py"))
    assert not re.search(r"^\s*(import|from)\s+(smtplib|requests|httpx|twilio|aiohttp|urllib)", src, re.M)
