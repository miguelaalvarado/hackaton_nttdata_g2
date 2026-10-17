"""Regenera schemas y ejemplos. Ejecutar desde ai_decision_engine/: python contracts/generate_contracts.py"""
import json, pathlib, sys
sys.path.insert(0, ".")
from app.schemas import AgentProposalRequest, DecisionRequest, DecisionResponse
from tests.conftest import BASE
from fastapi.testclient import TestClient
from app.main import app
import copy
c = pathlib.Path("contracts"); c.mkdir(exist_ok=True)
(c/"decision_request.schema.json").write_text(json.dumps(DecisionRequest.model_json_schema(), indent=2, ensure_ascii=False))
(c/"decision_response.schema.json").write_text(json.dumps(DecisionResponse.model_json_schema(), indent=2, ensure_ascii=False))
cl = TestClient(app)
def ex(name, **o):
    d = copy.deepcopy(BASE)
    for k, v in o.items():
        n = d; *ps, leaf = k.split(".")
        for p in ps: n = n[p]
        n[leaf] = v
    (c/f"example_{name}_request.json").write_text(json.dumps(d, indent=2, ensure_ascii=False))
    r = cl.post("/v1/decisions", json=d).json()
    (c/f"example_{name}_response.json").write_text(json.dumps(r, indent=2, ensure_ascii=False))
ex("low")
ex("medium", **{"risk_score.value": 50, "behavior.missed_payments_last_6m": 1, "behavior.on_time_payment_ratio_6m": 0.75, "behavior.credit_utilization": 0.6})
ex("high", **{"risk_score.value": 85, "behavior.missed_payments_last_6m": 3, "behavior.on_time_payment_ratio_6m": 0.4, "behavior.credit_utilization": 0.95, "behavior.payment_trend": "worsening"})

(c/"agent_proposal_request.schema.json").write_text(json.dumps(AgentProposalRequest.model_json_schema(), indent=2, ensure_ascii=False))
ap = {"proposal_id": "prop-001", "agent_id": "agente-cobranza-demo", "agent_version": "0.1",
      "context": copy.deepcopy(BASE),
      "proposal": {"strategy_code": "friendly_reminder", "channel": "whatsapp",
                   "contact_at": "2026-11-03T10:00:00-05:00",
                   "body": "Hola Lucía, te recordamos que tu cuota de PEN 450.00 vence el 2026-11-05. "
                           "Gracias por mantener tus pagos al día.\n\nSi no deseas recibir estos avisos, responde BAJA.",
                   "offers": [], "rationale": "Cliente puntual; recordatorio ligero."}}
(c/"example_agent_proposal_request.json").write_text(json.dumps(ap, indent=2, ensure_ascii=False))
(c/"example_agent_proposal_response.json").write_text(json.dumps(cl.post("/v1/agent-proposals/evaluate", json=ap).json(), indent=2, ensure_ascii=False))
