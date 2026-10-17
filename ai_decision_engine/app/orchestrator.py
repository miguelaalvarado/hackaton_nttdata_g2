"""Orquestador NEXO AI + componentes 1-7. Reutiliza los módulos existentes; no los reescribe.

Cada componente: (a) lee el estado vigente de la BD, (b) devuelve un resultado estructurado y (c) deja su corrida en
`agent_runs`. Hoy son deterministas (sin LLM) detrás de una interfaz estable: un LLM puede sustituir a cualquiera
de ellos SIN privilegios nuevos, porque el orquestador nunca escribe saldos/pagos y toda propuesta pasa por
el AI Decision Engine (`evaluate_agent_proposal`) y por revisión humana.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from . import compliance, interpreter, llm, llm_agent, messages, scheduling, strategy
from .db import connect, transaction, utcnow
from .demo_agent import build_context
from .repositories import AgentRunRepo, ContactRepo, ConversationRepo, CustomerRepo
from .schemas import AgentProposal, AgentProposalRequest, StrategyCode

ORCHESTRATOR = "orchestrator"
PROPOSER_ID = "nexo-orchestrator"
DIFFICULTY = re.compile(r"no puedo|dificultad|difícil|dificil|fin de mes|no tengo|atras", re.IGNORECASE)


# Registro de componentes (alimenta el mapa visual). 'engine' real se decide en tiempo de ejecución y queda en cada traza.
COMPONENTS = [
    ("orchestrator", "0 · Orchestrator", "Coordina el caso y se detiene ante disputa, pago pendiente o exclusión.", "app/orchestrator.py", False),
    ("risk_agent", "1 · Risk", "Interpreta el score externo con evidencia y bandas de riesgo.", "app/interpreter.py", False),
    ("strategy_agent", "2 · Strategy", "Elige la estrategia preventiva según la banda de riesgo.", "app/strategy.py", False),
    ("contact_agent", "3 · Contact", "Canal y momento permitidos (consentimiento, exclusiones, frecuencia, ventana).", "app/scheduling.py", False),
    ("conversational_agent", "4 · Conversational", "Redacta el borrador empático. ÚNICO componente con adaptador LLM opcional.", "app/messages.py · app/llm.py", True),
    ("negotiation_agent", "5 · Negotiation", "Opciones condicionadas 'sujetas a evaluación'; sin montos ni compromisos.", "app/orchestrator.py", False),
    ("compliance_agent", "6 · Compliance", "AI Decision Engine: valida propuesta y deja la decisión pendiente de humano.", "app/compliance.py", False),
    ("followup_learning", "7 · Follow-up & Learning", "Reevalúa y fija la próxima fecha; estadística simple de respuesta por canal.", "app/scheduling.py", False),
]


class Run:
    """Registro de una corrida de componente en agent_runs (transacción corta e independiente)."""

    def __init__(self, orch_id: str, customer_id: str, case_version: int):
        self.orch_id, self.customer_id, self.case_version = orch_id, customer_id, case_version
        self.steps: list[dict] = []

    def log(self, agent: str, inp: dict, out: dict, decision_id: str | None = None, status: str = "OK",
            engine: str = "rules") -> dict:
        out = {**out, "engine": engine}  # honestidad en la traza: 'rules' (determinista) o 'llm:<modelo>'
        started = utcnow()
        with connect() as c, transaction(c):
            AgentRunRepo(c).insert(started, utcnow(), agent_name=agent, customer_id=self.customer_id,
                                   case_version=self.case_version, trigger=f"orchestrator:{self.orch_id}", status=status,
                                   input=inp, output=out, decision_id=decision_id)
        step = {"agent": agent, "status": status, "output": out}
        self.steps.append(step)
        return step


# ------------------------------------------------------------ componentes 1-5
def risk_agent(ctx) -> dict:
    """1. Risk Agent: interpreta el score externo con evidencia (módulo existente)."""
    return interpreter.interpret(ctx).model_dump(mode="json")


def strategy_agent(ctx, interp) -> dict:
    """2. Strategy Agent: estrategia preventiva según la banda de riesgo (módulo existente)."""
    return strategy.select_strategy(ctx, interp).model_dump(mode="json")


def contact_agent(conn, customer_id: str, now: datetime) -> dict:
    """3. Contact Agent: canal y momento permitidos por política (consentimiento, exclusiones, frecuencia, ventana)."""
    plan = scheduling.plan_next_action(conn, customer_id, now, scheduling.load_policy(conn))
    return plan.public()


def conversational_agent_rules(ctx, strat, channel: str, last_reply: str | None) -> dict:
    """Plantillas deterministas."""
    draft = messages.draft_message(ctx, strat.model_copy(update={"channel": channel}))
    return {"subject": draft.subject, "body": draft.body, "language": draft.language, "responds_to": last_reply, "engine": "rules"}


def conversational_agent(ctx, strat, channel: str, last_reply: str | None, offers: list[str] | None = None) -> dict:
    """4. Conversational Agent: plantillas (reglas) o, si hay ANTHROPIC_API_KEY, redacción con LLM. El pie de baja lo pone el código."""
    draft = messages.draft_message(ctx, strat.model_copy(update={"channel": channel}))
    out = {"subject": draft.subject, "body": draft.body, "language": draft.language, "responds_to": last_reply,
           "engine": "rules"}
    if llm.enabled():
        try:
            text = llm.draft_body(first_name=ctx.customer.first_name, language=ctx.customer.language,
                                  amount=f"{ctx.account.currency} {ctx.account.installment_amount:,.2f}",
                                  due_date=ctx.account.next_due_date.isoformat(), objective=strat.objective,
                                  offers=offers or [], last_reply=last_reply)
            if offers and not compliance.HEDGE_PATTERN.search(text):  # garantía en código: no depende del LLM
                text += " Las opciones de apoyo que te comentamos están sujetas a evaluación."
            out["body"] = text + messages.FOOTER[ctx.customer.language]
            out["engine"] = f"llm:{llm.model_name()}"
        except Exception as exc:  # noqa: BLE001 - cualquier fallo del proveedor => plantillas, con traza del error
            out["llm_error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
    return out


def conversational_openai(ctx, strat, channel: str, last_reply: str | None) -> tuple[dict, dict | None]:
    """4. Conversational Agent con OpenAI (tool calling de solo lectura). Devuelve (conv, parsed|None).

    Si la API falla o el modelo incumple (no consultó la BD, JSON inválido...) cae a reglas y lo etiqueta como fallback."""
    ai = llm_agent.run_agent(ctx.customer.customer_id, last_reply, strat.code.value, channel)
    meta = {"provider": "openai", "model": ai["model"], "tools_used": ai["tools_used"], "tool_log": ai["tool_log"],
            "duration_ms": ai["duration_ms"], "usage": ai["usage"], "rounds": ai["rounds"], "response_ids": ai["response_ids"]}
    if not ai["ok"]:
        conv = conversational_agent_rules(ctx, strat, channel, last_reply)
        conv.update(meta | {"engine": "rules", "result": "fallback_to_rules",
                            "fallback": {"from": f"openai:{ai['model'] or '?'}", "reason": ai["error"]}})
        return conv, None
    p = ai["parsed"]
    body = p["body"].strip()
    if p["offers"] and not compliance.HEDGE_PATTERN.search(body):  # garantía en código: no depende del LLM
        body += " Las opciones de apoyo que te comentamos están sujetas a evaluación."
    if not compliance.OPT_OUT_PATTERN.search(body):
        body += messages.FOOTER[ctx.customer.language]
    conv = {"subject": p["subject"], "body": body, "language": ctx.customer.language, "responds_to": last_reply,
            "engine": f"llm:openai:{ai['model']}", "result": "ok", "interpretation": p["interpretation"],
            "customer_intent": p["customer_intent"], "intent_confidence": p["intent_confidence"],
            "needs_human_attention": p["needs_human_attention"], "llm_strategy_code": p["strategy_code"],
            "llm_offers": p["offers"], "llm_rationale": p["rationale"]} | meta
    return conv, p


def negotiation_agent(strat_offers: list[str], last_reply: str | None) -> dict:
    """5. Negotiation Agent: solo opciones condicionadas ('sujetas a evaluación'); nunca montos ni compromisos."""
    offers = []
    for o in strat_offers[:3]:  # tope de 3 opciones; toda opción debe quedar condicionada
        o = o.strip()
        if o and not re.search(r"sujet[oa]s? a (evaluaci[oó]n|aprobaci[oó]n)", o, re.IGNORECASE):
            o += " (sujeta a evaluación)"
        if o and o not in offers:
            offers.append(o)
    extra = None
    if last_reply and DIFFICULTY.search(last_reply) and not any("Reprogramación" in o for o in offers):
        extra = "Reprogramación de fecha de pago (sujeta a evaluación)"
        offers.append(extra)
    return {"offers": offers, "added_for_customer_difficulty": extra,
            "guardrail": "Las ofertas son propuestas condicionadas; ningún compromiso se crea sin aprobación humana."}


# ---------------------------------------------------------------- orquestador
def propose_case(customer_id: str, now: datetime | None = None) -> dict:
    """Pasos: consulta BD → riesgo → estrategia → contacto → mensaje → negociación → validación (Decision Engine)."""
    from .main import evaluate_agent_proposal  # import tardío: main importa routes que importan este módulo
    now = now or utcnow()
    orch_id = uuid.uuid4().hex[:10]
    with connect() as conn:
        customer = CustomerRepo(conn).get(customer_id)
        if customer is None:
            raise LookupError(f"Cliente desconocido: {customer_id}")
        run = Run(orch_id, customer_id, customer["case_version"])
        replies = [m for m in ConversationRepo(conn).for_customer(customer_id) if m["sender"] == "customer"]
        last_reply = replies[-1]["text"] if replies else None
        run.log(ORCHESTRATOR, {"customer_id": customer_id, "now": now.isoformat()},
                {"step": "consulta_bd", "case_version": customer["case_version"], "dispute_open": bool(customer["dispute_open"]),
                 "opted_out_all": bool(customer["opted_out_all"]), "needs_reevaluation": bool(customer["needs_reevaluation"])})
        try:
            ctx, _ = build_context(conn, customer_id, now)
        except ValueError as exc:
            run.log(ORCHESTRATOR, {}, {"halted": True, "reason": str(exc)}, status="SKIPPED")
            return {"orchestration_id": orch_id, "customer_id": customer_id, "halted": True, "reason": str(exc), "steps": run.steps}
        contact = contact_agent(conn, customer_id, now)

    if contact["hold"]:
        run.log(ORCHESTRATOR, {}, {"halted": True, "reason": contact["reason"], "hold": contact["hold"]}, status="SKIPPED")
        return {"orchestration_id": orch_id, "customer_id": customer_id, "halted": True, "hold": contact["hold"],
                "reason": contact["reason"], "steps": run.steps}
    if contact["channel"] is None:
        run.log(ORCHESTRATOR, {}, {"halted": True, "reason": contact["reason"]}, status="SKIPPED")
        return {"orchestration_id": orch_id, "customer_id": customer_id, "halted": True, "reason": contact["reason"], "steps": run.steps}

    interp_model = interpreter.interpret(ctx)
    run.log("risk_agent", {"score": ctx.risk_score.value, "dpd": ctx.account.days_past_due}, risk_agent(ctx))
    strat_model = strategy.select_strategy(ctx, interp_model)
    run.log("strategy_agent", {"band": interp_model.band.value}, strategy_agent(ctx, interp_model))
    run.log("contact_agent", {"policy": "scheduling.Policy"}, contact)
    parsed = None
    if llm.provider() == "openai":
        conv, parsed = conversational_openai(ctx, strat_model, contact["channel"], last_reply)
    else:
        conv = conversational_agent(ctx, strat_model, contact["channel"], last_reply, strat_model.proposed_offers)
    run.log("conversational_agent", {"channel": contact["channel"], "last_reply": last_reply, "provider": llm.provider() or "rules"},
            conv, engine=conv["engine"])
    nego = negotiation_agent(parsed["offers"] if parsed else strat_model.proposed_offers, last_reply)
    run.log("negotiation_agent", {"strategy": strat_model.code.value}, nego)

    body = conv["body"]
    if nego["added_for_customer_difficulty"]:
        body += "\n\nSi lo necesitas, puedes consultar la reprogramación de tu fecha de pago (sujeta a evaluación)."
    contact_at = datetime.fromisoformat(contact["scheduled_at"])
    proposal = AgentProposalRequest(
        proposal_id=f"prop-{orch_id}", agent_id=PROPOSER_ID, agent_version="orq-1.0", context=ctx,
        proposal=AgentProposal(strategy_code=StrategyCode(parsed["strategy_code"]) if parsed else strat_model.code,
                               channel=contact["channel"], contact_at=contact_at,
                               subject=conv["subject"], body=body, offers=nego["offers"],
                               rationale=(f"{parsed['rationale']} " if parsed else f"{strat_model.rationale} ") + contact["reason"]))
    decision = evaluate_agent_proposal(proposal)  # AI Decision Engine = supervisor/Compliance (persiste y deja pendiente)
    run.log("compliance_agent", {"proposal_id": proposal.proposal_id},
            {"status": decision.compliance.status, "violations": decision.compliance.violations,
             "checks_failed": [c.rule_id for c in decision.compliance.checks if not c.passed],
             "alignment_notes": decision.alignment_notes}, decision_id=decision.decision_id)
    return {"orchestration_id": orch_id, "customer_id": customer_id, "halted": False,
            "case_version": decision.case_version, "decision_id": decision.decision_id,
            "compliance_status": decision.compliance.status, "violations": decision.compliance.violations,
            "review_status": decision.review_status, "requires_human_approval": True, "sent": False,
            "conversational": {k: conv.get(k) for k in ("engine", "result", "provider", "model", "tools_used", "duration_ms", "usage",
                                                      "interpretation", "customer_intent", "intent_confidence", "needs_human_attention",
                                                      "fallback")},
            "proposed": {"strategy": StrategyCode(parsed["strategy_code"]).value if parsed else strat_model.code.value, "channel": contact["channel"],
                         "contact_at": contact["scheduled_at"], "offers": nego["offers"]}, "steps": run.steps}


def followup_agent(customer_id: str, now: datetime | None = None) -> dict:
    """7. Follow-up & Learning Agent: próxima fecha vigente + aprendizaje simple de respuesta por canal."""
    now = now or utcnow()
    with connect() as conn:
        with transaction(conn):
            res = scheduling.reevaluate_customer(conn, customer_id, now, "FOLLOWUP_AGENT")
        contacts = ContactRepo(conn).for_customer(customer_id)
        stats: dict[str, dict] = {}
        for c in contacts:
            if c["direction"] != "outbound":
                continue
            s = stats.setdefault(c["channel"], {"sent": 0, "responded": 0})
            s["sent"] += 1
            s["responded"] += c["outcome"] in ("RESPONDED", "REPLIED")
        best = max(stats, key=lambda k: stats[k]["responded"] / stats[k]["sent"], default=None) if stats else None
        from .repositories import ActionRepo
        nxt = next((a for a in ActionRepo(conn).active_for_customer(customer_id) if a["status"] in ("PENDING", "DUE")), None)
    return {"next_action": nxt, "next_followup_at": nxt["scheduled_at"] if nxt else None,
            "channel_stats": stats, "best_channel_so_far": best, "reevaluation": res["plan"]["action_type"]}
