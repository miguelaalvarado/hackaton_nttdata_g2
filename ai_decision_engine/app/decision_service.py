"""Persistencia y revisión humana de decisiones. Preserva el contrato público de `DecisionResponse`."""
from __future__ import annotations

import sqlite3
from datetime import datetime

from .db import fmt_money, to_iso, transaction, utcnow
from .repositories import (
    AgentRunRepo, CustomerRepo, DecisionRepo, InstallmentRepo, LoanRepo, PaymentRepo,
)
from .schemas import DecisionRequest, DecisionResponse
from . import scheduling


class ReviewConflict(Exception):
    def __init__(self, message: str, status: int = 409, detail: dict | None = None):
        super().__init__(message)
        self.message, self.status, self.detail = message, status, detail or {"code": "CONFLICT", "message": message}


class DecisionNotFound(Exception):
    pass


def ensure_customer(conn: sqlite3.Connection, now: datetime, req: DecisionRequest) -> dict:
    """Garantiza que el cliente exista (FK). No sobrescribe estado financiero ya persistido."""
    repo = CustomerRepo(conn)
    c = repo.get(req.customer.customer_id)
    if c is None:
        c = repo.create(now, req.customer.customer_id, req.customer.first_name, req.customer.language,
                        [ch.value for ch in req.customer.contact_consent],
                        req.customer.preferred_channel.value if req.customer.preferred_channel else None)
    return c


def reconciliation_notes(conn: sqlite3.Connection, req: DecisionRequest) -> list[str]:
    """Si la BD tiene el saldo del cliente, avisa cuando el contexto del agente difiere (la BD manda)."""
    notes = []
    loans = LoanRepo(conn).for_customer(req.customer.customer_id)
    if loans:
        db_bal = loans[0]["outstanding_cents"]
        req_bal = round(req.account.outstanding_balance * 100)
        if db_bal != req_bal:
            notes.append(f"Saldo del contexto ({fmt_money(req_bal, req.account.currency)}) difiere del saldo vigente en la "
                         f"base de datos ({fmt_money(db_bal, loans[0]['currency'])}); prevalece la base de datos.")
    return notes


def save_decision(conn: sqlite3.Connection, decision: DecisionResponse, req: DecisionRequest,
                  agent_name: str, run_input: dict) -> DecisionResponse:
    """Guarda la decisión y su traza de agente. Verifica que la versión declarada no esté ya obsoleta."""
    started = utcnow()
    with transaction(conn):
        now = utcnow()
        customer = ensure_customer(conn, now, req)
        current = customer["case_version"]
        version = req.case_version if req.case_version is not None else current
        if version > current:
            raise ReviewConflict(f"case_version {version} es posterior a la vigente ({current})", 422)
        inst = InstallmentRepo(conn).current_open(customer["customer_id"])
        decision.case_version = version
        decision.validity = "valid" if version == current else "stale"
        DecisionRepo(conn).insert(
            now, decision_id=decision.decision_id, request_id=decision.request_id, customer_id=customer["customer_id"],
            installment_id=inst["installment_id"] if inst else None, source=decision.source,
            agent_id=decision.agent.agent_id if decision.agent else None,
            proposal_id=decision.agent.proposal_id if decision.agent else None, case_version=version,
            compliance_status=decision.compliance.status,
            channel=decision.message.channel.value if decision.message.channel else None,
            payload_json=decision.model_dump_json())
        if decision.validity == "stale":
            conn.execute("UPDATE decisions SET validity='stale', stale_reason=? WHERE decision_id=?",
                         (f"Creada con case_version {version} < vigente {current}", decision.decision_id))
            decision.stale_reason = f"Creada con case_version {version} < vigente {current}"
        else:
            CustomerRepo(conn).clear_reevaluation(now, customer["customer_id"])
        AgentRunRepo(conn).insert(
            started, utcnow(), agent_name=agent_name, customer_id=customer["customer_id"], case_version=version,
            trigger="evaluate", status="OK", input=run_input,
            output={"decision_id": decision.decision_id, "compliance": decision.compliance.status,
                    "violations": decision.compliance.violations, "strategy": decision.strategy.code.value,
                    "validity": decision.validity}, decision_id=decision.decision_id)
    return decision


def load_decision(conn: sqlite3.Connection, decision_id: str) -> DecisionResponse:
    row = DecisionRepo(conn).get(decision_id)
    if row is None:
        raise DecisionNotFound(decision_id)
    d = DecisionResponse.model_validate_json(row["payload_json"])
    d.review_status = row["review_status"]
    d.case_version = row["case_version"]
    d.validity = row["validity"]
    d.stale_reason = row["stale_reason"]
    return d


def review_in_tx(conn: sqlite3.Connection, now: datetime, decision_id: str, reviewer_id: str,
                 action: str, comment: str, *, actor_role: str) -> dict:
    """Única ruta de revisión (HTTP directo, POST /v1/events y dashboard): autorización, cumplimiento,
    review_status y case_version se validan aquí. Debe ejecutarse dentro de una transacción abierta."""
    if actor_role != "human":
        raise ReviewConflict("Solo un revisor humano puede aprobar o rechazar decisiones", 403,
                             {"code": "FORBIDDEN_ROLE", "message": f"El rol '{actor_role}' no puede revisar decisiones"})
    repo = DecisionRepo(conn)
    row = repo.get(decision_id)
    if row is None:
        raise DecisionNotFound(decision_id)
    if action not in ("approve", "reject") or not reviewer_id:
        raise ReviewConflict("Revisión inválida: se requiere reviewer_id y action approve|reject", 422)
    if action == "approve" and row["compliance_status"] == "blocked_needs_rewrite":
        raise ReviewConflict("No se puede aprobar una decisión bloqueada por cumplimiento")
    if row["review_status"] != "pending":
        raise ReviewConflict(f"La decisión ya fue {row['review_status']}")

    customer = CustomerRepo(conn).get(row["customer_id"])
    if action == "approve":
        if row["case_version"] != customer["case_version"] or row["validity"] != "valid":
            raise ReviewConflict(
                "La decisión se generó con una versión obsoleta del expediente: requiere reevaluación",
                detail={"code": "STALE_CASE_VERSION", "decision_case_version": row["case_version"],
                        "current_case_version": customer["case_version"], "stale_reason": row["stale_reason"],
                        "required_action": "reevaluate"})
        if customer["dispute_open"]:
            raise ReviewConflict("Hay una disputa abierta: la cobranza está suspendida hasta revisión humana",
                                 detail={"code": "DISPUTE_OPEN", "required_action": "resolve_dispute"})
        if PaymentRepo(conn).pending_for_customer(customer["customer_id"]):
            raise ReviewConflict("Hay un pago pendiente de verificación: no se aprueban recomendaciones hasta confirmarlo",
                                 detail={"code": "PAYMENT_PENDING", "required_action": "verify_payment"})
    status = "approved" if action == "approve" else "rejected"
    repo.set_review(now, decision_id, status, reviewer_id, comment)
    out = {"decision_id": decision_id, "review_status": status, "reviewer_id": reviewer_id}
    if status == "approved":
        d = load_decision(conn, decision_id)
        contact_at = None
        if d.strategy.contact_date is not None:
            from datetime import datetime as _dt, time, timezone
            from .calendar_pe import LIMA
            contact_at = _dt.combine(d.strategy.contact_date, time(d.strategy.contact_hour), tzinfo=LIMA).astimezone(timezone.utc)
        res = scheduling.on_decision_approved(conn, row, d.message.channel.value if d.message.channel else None,
                                              contact_at, now)
        out["scheduled_action_id"] = res["created"]
    return out


def review_decision(conn: sqlite3.Connection, decision_id: str, reviewer_id: str, action: str, comment: str,
                    *, actor_role: str) -> dict:
    with transaction(conn):
        return review_in_tx(conn, utcnow(), decision_id, reviewer_id, action, comment, actor_role=actor_role)
