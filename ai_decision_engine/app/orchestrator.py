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

from . import compliance, interpreter, messages, scheduling, strategy
from .db import connect, transaction, utcnow
from .demo_agent import build_context
from .repositories import AgentRunRepo, ContactRepo, ConversationRepo, CustomerRepo
from .schemas import AgentProposal, AgentProposalRequest

ORCHESTRATOR = "orchestrator"
PROPOSER_ID = "nexo-orchestrator"
DIFFICULTY = re.compile(r"no puedo|dificultad|difícil|dificil|fin de mes|no tengo|atras", re.IGNORECASE)


class Run:
    """Registro de una corrida de componente en agent_runs (transacción corta e independiente)."""

    def __init__(self, orch_id: str, customer_id: str, case_version: int):
        self.orch_id, self.customer_id, self.case_version = orch_id, customer_id, case_version
        self.steps: list[dict] = []

    def log(self, agent: str, inp: dict, out: dict, decision_id: str | None = None, status: str = "OK") -> dict:
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


def conversational_agent(ctx, strat, channel: str, last_reply: str | None) -> dict:
    """4. Conversational Agent: borrador de mensaje empático (plantillas) con contexto de la última respuesta."""
    draft = messages.draft_message(ctx, strat.model_copy(update={"channel": channel}))
    return {"subject": draft.subject, "body": draft.body, "language": draft.language, "responds_to": last_reply}


def negotiation_agent(strat_offers: list[str], last_reply: str | None) -> dict:
    """5. Negotiation Agent: solo opciones condicionadas ('sujetas a evaluación'); nunca montos ni compromisos."""
    offers = list(strat_offers)
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
    conv = conversational_agent(ctx, strat_model, contact["channel"], last_reply)
    run.log("conversational_agent", {"channel": contact["channel"]}, conv)
    nego = negotiation_agent(strat_model.proposed_offers, last_reply)
    run.log("negotiation_agent", {"strategy": strat_model.code.value}, nego)

    body = conv["body"]
    if nego["added_for_customer_difficulty"]:
        body += "\n\nSi lo necesitas, puedes consultar la reprogramación de tu fecha de pago (sujeta a evaluación)."
    contact_at = datetime.fromisoformat(contact["scheduled_at"])
    proposal = AgentProposalRequest(
        proposal_id=f"prop-{orch_id}", agent_id=PROPOSER_ID, agent_version="orq-1.0", context=ctx,
        proposal=AgentProposal(strategy_code=strat_model.code, channel=contact["channel"], contact_at=contact_at,
                               subject=conv["subject"], body=body, offers=nego["offers"],
                               rationale=f"{strat_model.rationale} {contact['reason']}"[:1500]))
    decision = evaluate_agent_proposal(proposal)  # AI Decision Engine = supervisor/Compliance (persiste y deja pendiente)
    run.log("compliance_agent", {"proposal_id": proposal.proposal_id},
            {"status": decision.compliance.status, "violations": decision.compliance.violations,
             "checks_failed": [c.rule_id for c in decision.compliance.checks if not c.passed],
             "alignment_notes": decision.alignment_notes}, decision_id=decision.decision_id)
    return {"orchestration_id": orch_id, "customer_id": customer_id, "halted": False,
            "case_version": decision.case_version, "decision_id": decision.decision_id,
            "compliance_status": decision.compliance.status, "violations": decision.compliance.violations,
            "review_status": decision.review_status, "requires_human_approval": True, "sent": False,
            "proposed": {"strategy": strat_model.code.value, "channel": contact["channel"],
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
