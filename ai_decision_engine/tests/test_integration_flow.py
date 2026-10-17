"""Flujo NEXO extremo a extremo (10 pasos) por la API real con autenticación por rol: orquestador + 7 componentes."""
import pytest

from scripts.demo_flow import Flow
from tests.conftest import as_role


@pytest.fixture()
def seeded(client):
    assert client.post("/v1/dev/seed", headers=as_role(client, "system")).status_code == 200
    return client


@pytest.mark.parametrize("customer", ["CLI-0001", "CLI-0002", "CLI-0003", "CLI-0004"])
def test_full_ten_step_flow(seeded, customer):
    rep = Flow(seeded, seeded.keys, customer, verbose=False).run()
    assert [r["step"] for r in rep] == list(range(1, 11))


def test_all_components_leave_traces_linked_to_decision(seeded):
    out = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    runs = seeded.get("/v1/agent-runs?customer_id=CLI-0003", headers=as_role(seeded, "reader")).json()
    names = {r["agent_name"] for r in runs if r["trigger"] == f"orchestrator:{out['orchestration_id']}"}
    assert {"orchestrator", "risk_agent", "strategy_agent", "contact_agent", "conversational_agent",
            "negotiation_agent", "compliance_agent"} <= names
    assert any(r["decision_id"] == out["decision_id"] for r in runs)
    assert out["sent"] is False and out["review_status"] == "pending"


def test_orchestrator_requires_proposer_role_and_halts_on_dispute(seeded):
    assert seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}, headers=as_role(seeded, "bank_simulator")).status_code == 403
    assert seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}, headers=as_role(seeded, "reader")).status_code == 403
    ev = {"event_id": "d-1", "event_type": "DISPUTE_OPENED", "customer_id": "CLI-0003", "payload": {"reason": "x"}}
    assert seeded.post("/v1/events", json=ev, headers=as_role(seeded, "customer_channel")).status_code == 200
    out = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    assert out["halted"] and out["hold"] == "DISPUTE_OPEN"
    assert seeded.post("/v1/orchestrator/run", json={"customer_id": "NOPE"}).status_code == 404


def test_customer_difficulty_reply_adds_conditioned_offer(seeded):
    ev = {"event_id": "r-1", "event_type": "CUSTOMER_REPLIED", "customer_id": "CLI-0003",
          "payload": {"text": "No puedo pagar hasta fin de mes", "channel": "email"}}
    assert seeded.post("/v1/events", json=ev, headers=as_role(seeded, "customer_channel")).status_code == 200
    out = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    assert any("Reprogramación" in o and "sujeta a evaluación" in o for o in out["proposed"]["offers"])
    assert out["compliance_status"] == "pending_human_approval", out["violations"]


def test_llm_adapter_is_optional_labeled_and_falls_back(seeded, monkeypatch):
    """Sin clave: reglas. Con clave: etiqueta llm:<modelo>, añade el pie de baja por código y pasa por cumplimiento.
    NOTA: usa un doble del SDK; NO prueba la API real de un proveedor."""
    from app import llm

    class Msg:  # doble mínimo del SDK
        def __init__(self, t): self.type, self.text = "text", t

    class Client:
        class messages:
            @staticmethod
            def create(**kw):
                assert "system" in kw and kw["max_tokens"] > 0
                return type("R", (), {"content": [Msg("Hola Demo, queremos ayudarte con tu cuota. Cuéntanos cómo podemos apoyarte.")]})()

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    out = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    assert {s["agent"]: s["output"]["engine"] for s in out["steps"] if s["agent"] != "orchestrator"} == {
        a: "rules" for a in ("risk_agent", "strategy_agent", "contact_agent", "conversational_agent", "negotiation_agent", "compliance_agent")}

    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-not-a-secret")
    real = llm.draft_body
    monkeypatch.setattr(llm, "draft_body", lambda **kw: real(client=Client, **kw))
    out2 = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    conv = next(s["output"] for s in out2["steps"] if s["agent"] == "conversational_agent")
    assert conv["engine"].startswith("llm:") and "BAJA" in conv["body"] and conv["body"].startswith("Hola Demo")
    assert out2["compliance_status"] == "pending_human_approval"

    def boom(**kw): raise RuntimeError("proveedor caído")
    monkeypatch.setattr(llm, "draft_body", boom)
    out3 = seeded.post("/v1/orchestrator/run", json={"customer_id": "CLI-0003"}).json()
    conv3 = next(s["output"] for s in out3["steps"] if s["agent"] == "conversational_agent")
    assert conv3["engine"] == "rules" and "proveedor caído" in conv3["llm_error"]
