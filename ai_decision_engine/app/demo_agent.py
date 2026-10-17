"""Agente DEMO determinista (sin LLM): arma una propuesta a partir del estado persistido.

Solo existe para la demo local: demuestra el flujo agente → POST /v1/agent-proposals/evaluate → revisión humana.
Los 7 agentes reales proponen por el mismo contrato; ninguno puede modificar saldos, pagos ni decisiones aprobadas.
"""
from __future__ import annotations

import sqlite3
import uuid
from datetime import date, datetime

from . import interpreter, messages, strategy
from .calendar_pe import LIMA
from .repositories import ActionRepo, CustomerRepo, InstallmentRepo, LoanRepo
from .schemas import AgentProposal, AgentProposalRequest, DecisionRequest

AGENT_ID = "demo-strategy-agent"


def build_proposal(conn: sqlite3.Connection, customer_id: str, now: datetime) -> AgentProposalRequest:
    customer = CustomerRepo(conn).get(customer_id)
    inst = InstallmentRepo(conn).current_open(customer_id)
    if inst is None:
        raise ValueError("El cliente no tiene cuotas abiertas")
    loan = LoanRepo(conn).get(inst["loan_id"])
    dpd = max((now.astimezone(LIMA).date() - date.fromisoformat(inst["due_date"])).days, 0)
    consent = [c for c in customer["consent_channels"] if c not in customer["opted_out_channels"]] if not customer["opted_out_all"] else []
    if not consent:
        raise ValueError("El cliente no tiene canales permitidos (exclusión voluntaria o sin consentimiento)")
    nxt = next((a for a in ActionRepo(conn).active_for_customer(customer_id) if a["status"] in ("PENDING", "DUE") and a["channel"]), None)
    score = min(95, 15 + 8 * dpd + (10 if nxt and nxt["action_type"] == "ADVISOR_CALL" else 0))
    ctx = DecisionRequest.model_validate({
        "request_id": f"demo-{uuid.uuid4().hex[:8]}", "case_version": customer["case_version"],
        "customer": {"customer_id": customer_id, "first_name": customer["first_name"], "language": customer["language"],
                     "contact_consent": consent, "preferred_channel": None},
        "account": {"product": loan["product"], "currency": loan["currency"],
                    "installment_amount": (inst["amount_cents"] - inst["paid_cents"]) / 100,
                    "next_due_date": inst["due_date"], "days_past_due": min(dpd, 365),
                    "outstanding_balance": loan["outstanding_cents"] / 100},
        "behavior": {"missed_payments_last_6m": min(6, dpd // 5), "on_time_payment_ratio_6m": max(0.0, 1 - dpd / 30),
                     "credit_utilization": 0.4, "payment_trend": "worsening" if dpd else "stable"},
        "risk_score": {"value": score, "model_version": "demo-risk-v0", "scored_at": now.astimezone(LIMA).date().isoformat()},
    })
    base = strategy.select_strategy(ctx, interpreter.interpret(ctx))
    channel = nxt["channel"] if nxt and nxt["channel"] in consent else (base.channel.value if base.channel else consent[0])
    draft_req = ctx
    draft = messages.draft_message(draft_req, base.model_copy(update={"channel": channel}))
    contact_at = datetime.fromisoformat(nxt["scheduled_at"]) if nxt else None
    return AgentProposalRequest(
        proposal_id=f"prop-{uuid.uuid4().hex[:8]}", agent_id=AGENT_ID, agent_version="demo-0.1", context=ctx,
        proposal=AgentProposal(strategy_code=base.code, channel=channel, contact_at=contact_at,
                               subject=draft.subject, body=draft.body, offers=base.proposed_offers,
                               rationale=base.rationale))
