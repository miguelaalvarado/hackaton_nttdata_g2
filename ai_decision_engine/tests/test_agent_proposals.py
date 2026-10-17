"""Integración con agentes de IA: el agente propone, el motor valida y explica."""
from tests.conftest import BASE, as_role
import copy

URL = "/v1/agent-proposals/evaluate"


def _payload(**proposal):
    ctx = copy.deepcopy(BASE)
    p = {
        "strategy_code": "friendly_reminder", "channel": "whatsapp",
        "contact_at": "2026-11-03T10:00:00-05:00",
        "body": "Hola Lucía, te recordamos que tu cuota vence el 5 de noviembre. "
                "Si no deseas recibir estos avisos, responde BAJA.",
        "offers": [], "rationale": "Cliente puntual; recordatorio ligero.",
    }
    p.update(proposal)
    return {"proposal_id": "prop-1", "agent_id": "agente-x", "agent_version": "0.1", "context": ctx, "proposal": p}


def test_valid_proposal_is_explained_and_pending_human(client):
    r = client.post(URL, json=_payload())
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["source"] == "agent_proposal" and d["agent"]["agent_id"] == "agente-x"
    assert d["baseline_strategy"] == "friendly_reminder" and d["alignment_notes"] == []
    assert d["compliance"]["status"] == "pending_human_approval"
    assert d["delivery"]["sent"] is False
    assert d["interpretation"]["evidence"]


def test_proposal_with_threats_is_blocked(client):
    d = client.post(URL, json=_payload(body="Último aviso: embargo. Responde BAJA.")).json()
    assert d["compliance"]["status"] == "blocked_needs_rewrite"
    assert any(v.startswith("C03") for v in d["compliance"]["violations"])


def test_proposal_rationale_and_offers_are_checked(client):
    d = client.post(URL, json=_payload(rationale="Insistir por su edad", offers=["Condonación garantizado"])).json()
    assert any(v.startswith("C11") for v in d["compliance"]["violations"])


def test_agent_call_on_holiday_blocked(client):
    d = client.post(URL, json=_payload(channel="phone_call", contact_at="2026-10-08T10:00:00-05:00")).json()
    assert any(v.startswith("C10") for v in d["compliance"]["violations"])


def test_misaligned_strategy_is_flagged_not_hidden(client):
    p = _payload(strategy_code="advisor_outreach")
    d = client.post(URL, json=p).json()
    assert d["baseline_strategy"] == "friendly_reminder"
    assert any("advisor_outreach" in n for n in d["alignment_notes"])


def test_sensitive_attribute_in_context_rejected(client):
    p = _payload()
    p["context"]["customer"]["religion"] = "x"
    assert client.post(URL, json=p).status_code == 422


def test_proposal_goes_through_same_human_review(client):
    d = client.post(URL, json=_payload()).json()
    ok = client.post(f"/v1/decisions/{d['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human"))
    assert ok.status_code == 200 and ok.json()["delivery"]["sent"] is False
