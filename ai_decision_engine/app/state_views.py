"""Vistas de lectura del estado persistido (las usan la API y el dashboard)."""
from __future__ import annotations

import json
import sqlite3

from .repositories import (
    ActionRepo, AgentRunRepo, ContactRepo, ConversationRepo, CustomerRepo, DecisionRepo, EventRepo, InstallmentRepo,
    LoanRepo, PaymentRepo, PromiseRepo,
)


def customer_summary(conn: sqlite3.Connection, customer_id: str) -> dict:
    c = CustomerRepo(conn).get(customer_id)
    loans = LoanRepo(conn).for_customer(customer_id)
    inst = InstallmentRepo(conn).current_open(customer_id)
    active = ActionRepo(conn).active_for_customer(customer_id)
    nxt = next((a for a in active if a["status"] in ("PENDING", "DUE")), None)
    return {
        **c, "outstanding_cents": sum(l["outstanding_cents"] for l in loans),
        "currency": loans[0]["currency"] if loans else None,
        "current_installment": inst, "next_action": nxt,
        "blocked_actions": [a for a in active if a["status"] == "BLOCKED"],
        "pending_decisions": len(DecisionRepo(conn).pending_for_customer(customer_id)),
    }


def list_customers(conn: sqlite3.Connection) -> list[dict]:
    return [customer_summary(conn, c["customer_id"]) for c in CustomerRepo(conn).list()]


def customer_state(conn: sqlite3.Connection, customer_id: str) -> dict | None:
    if CustomerRepo(conn).get(customer_id) is None:
        return None
    decisions = DecisionRepo(conn).for_customer(customer_id)
    for d in decisions:
        d["summary"] = json.loads(d.pop("payload_json"))
    events = EventRepo(conn).for_customer(customer_id)
    for e in events:
        e["payload"] = json.loads(e.pop("payload_json")); e["trace"] = json.loads(e.pop("trace_json"))
    runs = AgentRunRepo(conn).list(customer_id)
    for r in runs:
        r["input"] = json.loads(r.pop("input_json")); r["output"] = json.loads(r.pop("output_json"))
    return {
        "customer": customer_summary(conn, customer_id),
        "loans": LoanRepo(conn).for_customer(customer_id),
        "installments": InstallmentRepo(conn).for_customer(customer_id),
        "payments": PaymentRepo(conn).for_customer(customer_id),
        "contact_history": ContactRepo(conn).for_customer(customer_id),
        "conversations": ConversationRepo(conn).for_customer(customer_id),
        "promises": PromiseRepo(conn).for_customer(customer_id),
        "decisions": decisions,
        "scheduled_actions": ActionRepo(conn).for_customer(customer_id),
        "events": events,
        "agent_runs": runs,
    }
