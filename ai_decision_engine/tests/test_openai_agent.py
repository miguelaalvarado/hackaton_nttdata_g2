"""Conversational Agent con OpenAI (Responses API + tool calling de solo lectura).
Usa un DOBLE del SDK con las mismas formas que la API real; la prueba contra la API real es scripts/demo_openai.py."""
import json
import sqlite3
from types import SimpleNamespace as NS

import pytest

from app import llm, llm_agent
from app.db import connect
from app.events import EventIn, process_event
from app.orchestrator import propose_case
from app.repositories import ConversationRepo
from app.seed import seed_demo
from datetime import datetime, timezone

CID = "CLI-0003"
FINAL = {"customer_intent": "needs_more_time", "intent_confidence": "high",
         "interpretation": "El cliente indica dificultad temporal y pide más plazo.", "strategy_code": "proactive_support",
         "offers": ["Reprogramación de fecha de pago"], "subject": "Estamos para apoyarte",
         "body": "Hola Marta, gracias por avisarnos. Entendemos tu situación y queremos ayudarte con tu cuota. Si te sirve, "
                 "podemos evaluar reprogramar tu fecha de pago (sujeta a evaluación).",
         "rationale": "Cliente comunica dificultad; apoyo proactivo.", "needs_human_attention": False}


def call(name, **args):
    return NS(type="function_call", name=name, arguments=json.dumps(args), call_id=f"c-{name}")


def resp(output=(), text="", rid="r"):
    return NS(id=rid, output=list(output), output_text=text, usage=NS(input_tokens=100, output_tokens=40))


class FakeOpenAI:
    """Guion de turnos; registra los kwargs de cada llamada."""
    def __init__(self, turns):
        self.turns, self.calls = list(turns), []
        outer = self
        self.responses = NS(create=lambda **kw: outer._create(**kw))
    def _create(self, **kw):
        self.calls.append({k: (list(v) if k == "input" else v) for k, v in kw.items()})
        t = self.turns.pop(0)
        if isinstance(t, Exception):
            raise t
        return t


@pytest.fixture()
def env(isolated_db, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    with connect() as c:
        seed_demo(c)
        process_event(c, EventIn(event_id="rep-1", event_type="CUSTOMER_REPLIED", customer_id=CID, source="customer_channel",
                                 payload={"text": "Perdí horas de trabajo este mes, ¿puedo pagar más tarde?", "channel": "email"}))
    return monkeypatch


def use(monkeypatch, fake):
    monkeypatch.setattr(llm, "openai_client", lambda: fake)
    return fake


def good_turns():
    return [resp([call("get_customer_file", customer_id=CID)], rid="r1"),
            resp([call("get_commitments", customer_id=CID), call("get_conversation", customer_id=CID)], rid="r2"),
            resp(text=json.dumps(FINAL), rid="r3")]


def snapshot(db):
    con = sqlite3.connect(db)
    return [con.execute(q).fetchall() for q in ("select * from payments", "select paid_cents,status from installments order by 1,2",
                                                  "select outstanding_cents from loans order by 1", "select review_status from decisions")]


def conv_step(out):
    return next(s["output"] for s in out["steps"] if s["agent"] == "conversational_agent")


def test_real_flow_shape_tools_structured_output_and_trace(env, isolated_db):
    fake = use(env, FakeOpenAI(good_turns()))
    before = snapshot(isolated_db)
    out = propose_case(CID)
    # la llamada respeta el contrato de la Responses API
    first = fake.calls[0]
    assert first["model"] == "test-model" and first["store"] is False and first["tool_choice"] == "required"
    assert first["text"]["format"]["type"] == "json_schema" and first["text"]["format"]["strict"] is True
    assert {t["name"] for t in first["tools"]} == {"get_customer_file", "get_commitments", "get_conversation"}
    assert any(i.get("type") == "function_call_output" for i in fake.calls[2]["input"] if isinstance(i, dict))
    # etiquetado y traza
    conv = conv_step(out)
    assert conv["engine"] == "llm:openai:test-model" and conv["result"] == "ok"
    assert conv["tools_used"] == ["get_customer_file", "get_commitments", "get_conversation"]
    assert conv["duration_ms"] >= 0 and conv["usage"] == {"input_tokens": 300, "output_tokens": 120}
    assert conv["customer_intent"] == "needs_more_time" and "Perdí horas" in conv["responds_to"]
    runs = sqlite3.connect(isolated_db).execute("select output_json from agent_runs where agent_name='conversational_agent'").fetchall()
    logged = json.loads(runs[-1][0])
    assert logged["provider"] == "openai" and logged["model"] == "test-model" and logged["engine"].startswith("llm:openai")
    assert [t["tool"] for t in logged["tool_log"]] == conv["tools_used"]
    # el borrador pasó por el AI Decision Engine y queda pendiente de humano; el LLM no tocó dinero ni decisiones
    assert out["compliance_status"] == "pending_human_approval" and out["review_status"] == "pending" and out["sent"] is False
    assert "BAJA" in conv["body"]
    after = snapshot(isolated_db)
    assert after[:3] == before[:3] and after[3] == [("pending",)]
    assert out["proposed"]["offers"] == ["Reprogramación de fecha de pago (sujeta a evaluación)"]


def test_model_cannot_use_write_tools_or_other_customers(env, isolated_db):
    turns = [resp([call("get_customer_file", customer_id=CID), call("record_payment", customer_id=CID, amount=999),
                   call("get_commitments", customer_id="CLI-0001"), call("approve_decision", decision_id="x")], rid="r1"),
             resp(text=json.dumps(FINAL), rid="r2")]
    use(env, FakeOpenAI(turns))
    before = snapshot(isolated_db)
    out = propose_case(CID)
    conv = conv_step(out)
    errs = {(t["tool"]): t["error"] for t in conv["tool_log"] if "error" in t}
    assert errs == {"record_payment": "herramienta no permitida", "get_commitments": "customer_id fuera del alcance del caso",
                    "approve_decision": "herramienta no permitida"}
    assert conv["tools_used"] == ["get_customer_file"]
    assert snapshot(isolated_db)[:3] == before[:3]


def test_tool_set_has_no_write_capability():
    assert llm_agent.ALLOWED_TOOLS == {"get_customer_file", "get_commitments", "get_conversation"}
    src = open(llm_agent.__file__).read()
    assert "process_event" not in src and "review_decision" not in src and "INSERT" not in src.upper().replace("INSTRUCTIONS", "")


@pytest.mark.parametrize("turns,reason", [
    ([RuntimeError("503 de proveedor")], "503 de proveedor"),
    ([resp(text=json.dumps(FINAL))], "no consultó el expediente"),
    ([resp([call("get_customer_file", customer_id=CID)]), resp(text="esto no es json")], "ValidationError"),
])
def test_api_failure_or_noncompliant_model_falls_back_to_rules_and_is_labeled(env, isolated_db, turns, reason):
    use(env, FakeOpenAI(turns))
    out = propose_case(CID)
    conv = conv_step(out)
    assert conv["engine"] == "rules" and conv["result"] == "fallback_to_rules"
    assert reason in conv["fallback"]["reason"] and conv["fallback"]["from"] == "openai:test-model"
    assert out["review_status"] == "pending" and out["compliance_status"] == "pending_human_approval"  # el flujo continúa con reglas


def test_missing_model_name_falls_back(env):
    env.delenv("OPENAI_MODEL")
    use(env, FakeOpenAI([]))
    conv = conv_step(propose_case(CID))
    assert conv["engine"] == "rules" and "OPENAI_MODEL" in conv["fallback"]["reason"]


def test_llm_text_still_goes_through_compliance(env):
    bad = dict(FINAL, body="Último aviso: si no pagas procederemos al embargo. Hola Marta.")
    use(env, FakeOpenAI(good_turns()[:2] + [resp(text=json.dumps(bad))]))
    out = propose_case(CID)
    assert out["compliance_status"] == "blocked_needs_rewrite" and any(v.startswith("C03") for v in out["violations"])
    assert out["review_status"] == "pending"


def test_unsafe_strategy_choice_is_flagged_not_hidden(env):
    adv = dict(FINAL, strategy_code="advisor_outreach")
    use(env, FakeOpenAI(good_turns()[:2] + [resp(text=json.dumps(adv))]))
    out = propose_case(CID)
    assert out["proposed"]["strategy"] == "advisor_outreach" and out["review_status"] == "pending"


def test_llm_does_not_choose_channel(env):
    use(env, FakeOpenAI(good_turns()))
    out = propose_case(CID)
    contact = next(s["output"] for s in out["steps"] if s["agent"] == "contact_agent")
    assert out["proposed"]["channel"] == contact["channel"]


def test_provider_status_never_leaks_key_and_dotenv_is_private(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai"); monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-value"); monkeypatch.setenv("OPENAI_MODEL", "m")
    st = llm.status()
    assert st["active"] == "openai" and st["openai_key_present"] is True and "sk-secret-value" not in json.dumps(st)
    monkeypatch.delenv("OPENAI_API_KEY")
    assert llm.provider() is None  # sin clave no hay proveedor aunque LLM_PROVIDER esté puesto
    import subprocess
    ignored = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=llm.__file__.rsplit("/app/", 1)[0]).returncode
    assert ignored == 0  # .env está ignorado por git
