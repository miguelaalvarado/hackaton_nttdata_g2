"""Conversational Agent con IA real (OpenAI Responses API + function calling sobre SQLite, SOLO LECTURA).

Garantías (verificadas por pruebas):
- Las únicas herramientas son de consulta del expediente del cliente del caso; no existe ninguna herramienta de escritura.
  Una herramienta desconocida o de otro cliente se rechaza y queda en la traza.
- El modelo NO elige canal ni horario (los decide el Contact Agent por reglas) y no escribe en la BD: devuelve una
  propuesta estructurada que el orquestador envía al AI Decision Engine; la aprobación humana sigue siendo obligatoria.
- Sin tool-calling real (no consultó la base) o con cualquier fallo => se descarta y el orquestador usa reglas, etiquetado.
- `store=False`: no se persiste la conversación en OpenAI. Usar SOLO datos sintéticos.
"""
from __future__ import annotations

import json
import time
from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from . import llm
from .calendar_pe import LIMA
from .db import connect, utcnow
from .repositories import (
    ActionRepo, ContactRepo, ConversationRepo, CustomerRepo, InstallmentRepo, LoanRepo, PaymentRepo, PromiseRepo,
)

MAX_TOOL_ROUNDS = 5
INTENTS = ["will_pay", "needs_more_time", "cannot_pay", "disputes_charge", "asks_information", "wants_to_stop_contact", "unclear"]


class Proposal(BaseModel):
    """Propuesta estructurada del modelo (se valida con Pydantic antes de usarse)."""
    model_config = ConfigDict(extra="forbid")
    customer_intent: str
    intent_confidence: str
    interpretation: str = Field(max_length=600)
    strategy_code: str
    offers: list[str] = Field(max_length=4)
    subject: str = Field(max_length=150)
    body: str = Field(min_length=1, max_length=1200)
    rationale: str = Field(max_length=800)
    needs_human_attention: bool


SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["customer_intent", "intent_confidence", "interpretation", "strategy_code", "offers", "subject", "body",
                 "rationale", "needs_human_attention"],
    "properties": {
        "customer_intent": {"type": "string", "enum": INTENTS},
        "intent_confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "interpretation": {"type": "string"},
        "strategy_code": {"type": "string", "enum": ["friendly_reminder", "proactive_support", "advisor_outreach"]},
        "offers": {"type": "array", "items": {"type": "string"}},
        "subject": {"type": "string"}, "body": {"type": "string"}, "rationale": {"type": "string"},
        "needs_human_attention": {"type": "boolean"},
    },
}

INSTRUCTIONS = (
    "Eres el Conversational Agent de NEXO AI (cobranza temprana, datos FICTICIOS). Antes de responder DEBES consultar el expediente "
    "con las herramientas (get_customer_file, get_commitments y, si hay respuesta del cliente, get_conversation). Luego: "
    "1) interpreta la última respuesta del cliente (intención y confianza); 2) elige la estrategia más adecuada; 3) redacta un "
    "mensaje empático. Reglas estrictas: sin amenazas ni presión (nada de embargos, demandas, centrales de riesgo); no prometas ni "
    "garantices condonaciones, reprogramaciones ni aprobaciones: toda opción debe decir 'sujeta a evaluación'; no inventes montos ni "
    "fechas que no estén en las herramientas; no menciones edad, género, salud, religión ni otros atributos personales; no registres "
    "pagos ni compromisos (solo puedes proponer texto); si el cliente pide no ser contactado o disputa el cargo, marca "
    "needs_human_attention=true y no insistas en cobrar. No incluyas instrucciones de baja (las añade el sistema). Responde en el "
    "idioma del cliente."
)

TOOLS = [
    {"type": "function", "name": "get_customer_file", "strict": True,
     "description": "Expediente vigente del cliente: saldo, cuota abierta (monto, vencimiento, días de atraso), canales permitidos, "
                    "estado (disputa/exclusión) y últimos contactos. Solo lectura.",
     "parameters": {"type": "object", "additionalProperties": False, "required": ["customer_id"],
                    "properties": {"customer_id": {"type": "string"}}}},
    {"type": "function", "name": "get_commitments", "strict": True,
     "description": "Compromisos de pago registrados, pagos pendientes de verificación y acciones de seguimiento programadas. Solo lectura.",
     "parameters": {"type": "object", "additionalProperties": False, "required": ["customer_id"],
                    "properties": {"customer_id": {"type": "string"}}}},
    {"type": "function", "name": "get_conversation", "strict": True,
     "description": "Últimos mensajes de la conversación con el cliente. Solo lectura.",
     "parameters": {"type": "object", "additionalProperties": False, "required": ["customer_id"],
                    "properties": {"customer_id": {"type": "string"}}}},
]
ALLOWED_TOOLS = {t["name"] for t in TOOLS}


# ------------------------------------------------------------ herramientas (solo lectura)
def _file(conn, cid: str) -> dict:
    c = CustomerRepo(conn).get(cid)
    inst = InstallmentRepo(conn).current_open(cid)
    loans = LoanRepo(conn).for_customer(cid)
    out = {"customer": {"first_name": c["first_name"], "language": c["language"], "case_version": c["case_version"],
                        "allowed_channels": [] if c["opted_out_all"] else [x for x in c["consent_channels"] if x not in c["opted_out_channels"]],
                        "dispute_open": bool(c["dispute_open"]), "opted_out_all": bool(c["opted_out_all"])}}
    if loans:
        out["loan"] = {"product": loans[0]["product"], "currency": loans[0]["currency"],
                       "outstanding": loans[0]["outstanding_cents"] / 100}
    if inst:
        due = date.fromisoformat(inst["due_date"])
        out["current_installment"] = {"installment_id": inst["installment_id"], "due_date": inst["due_date"],
                                      "amount": inst["amount_cents"] / 100, "paid": inst["paid_cents"] / 100,
                                      "remaining": (inst["amount_cents"] - inst["paid_cents"]) / 100, "status": inst["status"],
                                      "days_past_due": max((utcnow().astimezone(LIMA).date() - due).days, 0)}
    out["recent_contacts"] = [{"channel": x["channel"], "direction": x["direction"], "outcome": x["outcome"], "at": x["occurred_at"]}
                              for x in ContactRepo(conn).for_customer(cid, 5)]
    return out


def _commitments(conn, cid: str) -> dict:
    return {"promises": [{"promised_amount": p["promised_amount_cents"] / 100, "promised_date": p["promised_date"], "status": p["status"]}
                         for p in PromiseRepo(conn).for_customer(cid)],
            "pending_payments": [{"amount": p["amount_cents"] / 100, "currency": p["currency"]} for p in PaymentRepo(conn).pending_for_customer(cid)],
            "scheduled_actions": [{"type": a["action_type"], "channel": a["channel"], "at": a["scheduled_at"], "status": a["status"]}
                                  for a in ActionRepo(conn).active_for_customer(cid)]}


def _conversation(conn, cid: str) -> dict:
    return {"messages": [{"from": m["sender"], "channel": m["channel"], "text": m["text"], "at": m["created_at"]}
                         for m in ConversationRepo(conn).for_customer(cid)[-10:]]}


_IMPL = {"get_customer_file": _file, "get_commitments": _commitments, "get_conversation": _conversation}


def run_tool(name: str, args: dict, case_customer_id: str) -> tuple[dict, dict]:
    """Ejecuta una herramienta con control de alcance. Devuelve (resultado_para_el_modelo, registro_para_la_traza)."""
    rec = {"tool": name, "args": args}
    if name not in ALLOWED_TOOLS:
        rec["error"] = "herramienta no permitida"
        return {"error": f"Herramienta '{name}' no existe o no está permitida"}, rec
    if args.get("customer_id") != case_customer_id:
        rec["error"] = "customer_id fuera del alcance del caso"
        return {"error": "Solo puedes consultar el cliente del caso actual"}, rec
    with connect() as conn:
        result = _IMPL[name](conn, case_customer_id)
    rec["rows"] = {k: (len(v) if isinstance(v, list) else 1) for k, v in result.items()}
    return result, rec


# ------------------------------------------------------------------- ejecución
def _get(item, key, default=None):
    return item.get(key, default) if isinstance(item, dict) else getattr(item, key, default)


def run_agent(customer_id: str, last_reply: str | None, strategy_hint: str, channel: str, client=None) -> dict:
    """Ejecuta el agente OpenAI. Devuelve siempre un dict con ok/provider/model/tools_used/duration_ms/usage/error(+parsed)."""
    model = llm.openai_model()
    res = {"ok": False, "provider": "openai", "model": model, "tools_used": [], "tool_log": [], "duration_ms": 0,
           "usage": {"input_tokens": 0, "output_tokens": 0}, "rounds": 0, "error": None, "response_ids": []}
    t0 = time.perf_counter()
    try:
        if not model:
            raise RuntimeError("OPENAI_MODEL no está definido")
        client = client or llm.openai_client()
        user = {"customer_id": customer_id, "canal_decidido_por_reglas": channel, "estrategia_base_por_reglas": strategy_hint,
                "ultima_respuesta_del_cliente": last_reply or "(el cliente aún no ha respondido)"}
        items: list = [{"role": "user", "content": json.dumps(user, ensure_ascii=False)}]
        kwargs = {"model": model, "instructions": INSTRUCTIONS, "tools": TOOLS, "store": False, "max_output_tokens": 1200,
                  "text": {"format": {"type": "json_schema", "name": "nexo_proposal", "schema": SCHEMA, "strict": True}}}
        if model.startswith(("o", "gpt-5")):  # modelos de razonamiento: con store=False hay que devolver su razonamiento cifrado
            kwargs["include"] = ["reasoning.encrypted_content"]
        resp = None
        for rnd in range(MAX_TOOL_ROUNDS + 1):
            resp = client.responses.create(input=items, tool_choice="required" if rnd == 0 else "auto", **kwargs)
            res["rounds"] = rnd + 1
            res["response_ids"].append(_get(resp, "id"))
            u = _get(resp, "usage")
            if u:
                res["usage"]["input_tokens"] += _get(u, "input_tokens", 0) or 0
                res["usage"]["output_tokens"] += _get(u, "output_tokens", 0) or 0
            calls = [i for i in _get(resp, "output", []) if _get(i, "type") == "function_call"]
            if not calls:
                break
            for it in _get(resp, "output", []):
                if _get(it, "type") == "function_call":  # modo sin estado (store=False): reenviar solo lo necesario, sin id de ítem
                    items.append({"type": "function_call", "call_id": _get(it, "call_id"), "name": _get(it, "name"),
                                  "arguments": _get(it, "arguments") or "{}"})
                else:                                       # p. ej. razonamiento cifrado de modelos o*/gpt-5
                    items.append(it)
            for call in calls:
                try:
                    args = json.loads(_get(call, "arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                out, rec = run_tool(_get(call, "name"), args, customer_id)
                res["tool_log"].append(rec)
                if "error" not in rec:
                    res["tools_used"].append(rec["tool"])
                items.append({"type": "function_call_output", "call_id": _get(call, "call_id"), "output": json.dumps(out, ensure_ascii=False)})
        else:
            raise RuntimeError("Demasiadas rondas de herramientas sin respuesta final")
        if "get_customer_file" not in res["tools_used"]:
            raise RuntimeError("El modelo no consultó el expediente (get_customer_file): respuesta descartada")
        parsed = Proposal.model_validate_json(_get(resp, "output_text") or "")
        if parsed.strategy_code not in SCHEMA["properties"]["strategy_code"]["enum"] or parsed.customer_intent not in INTENTS:
            raise ValueError("Valores fuera del esquema")
        res["parsed"], res["ok"] = parsed.model_dump(), True
    except Exception as exc:  # noqa: BLE001 - cualquier fallo => el orquestador usa reglas y lo etiqueta
        res["error"] = f"{type(exc).__name__}: {str(exc)[:240]}"
    res["duration_ms"] = int((time.perf_counter() - t0) * 1000)
    return res
