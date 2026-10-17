"""Motor de eventos: cada evento es idempotente (event_id), transaccional y deja traza.

Reglas duras:
- Un pago solo se reconoce con un PAYMENT_POSTED de `source="bank_simulator"` (ningún LLM/agente puede crearlo).
- El mismo `event_id` o el mismo `payment_ref` nunca se contabilizan dos veces.
- Cada cambio de saldo/compromiso/estado incrementa `case_version`, invalida propuestas pendientes y reevalúa acciones.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import date, datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import scheduling
from .auth import event_allowed
from .db import EVENT_TYPES, fmt_money, from_iso, new_id, to_cents, to_iso, transaction, utcnow
from .repositories import (
    ActionRepo, ContactRepo, ConversationRepo, CustomerRepo, DecisionRepo, EventRepo, InstallmentRepo, LoanRepo,
    PaymentRepo, PromiseRepo,
)

EventType = Enum("EventType", {t: t for t in EVENT_TYPES}, type=str)
OPT_OUT_TEXT = re.compile(r"\b(BAJA|STOP)\b", re.IGNORECASE)
CHANNELS = {"sms", "email", "whatsapp", "push", "phone_call", "in_person_visit"}


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=1, max_length=80)
    event_type: EventType
    customer_id: str = Field(min_length=1, max_length=64)
    installment_id: str | None = None
    source: str | None = Field(default=None, pattern="^(bank_simulator|customer_channel|human|agent|system|reader)$")
    occurred_at: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def aware(self):
        if self.occurred_at is not None and self.occurred_at.tzinfo is None:
            raise ValueError("occurred_at debe incluir zona horaria/offset")
        return self


class EventRejected(Exception):
    """Evento válido sintácticamente pero inaceptable por el estado/negocio. `status` sugiere el HTTP."""

    def __init__(self, reason: str, status: int = 422, audit: bool = True):
        super().__init__(reason)
        self.reason, self.status, self.audit = reason, status, audit


class Ctx:
    """Contexto de procesamiento de un evento dentro de la transacción."""

    def __init__(self, conn: sqlite3.Connection, ev: EventIn, now: datetime):
        self.c, self.ev, self.now = conn, ev, now
        self.customers, self.insts, self.loans = CustomerRepo(conn), InstallmentRepo(conn), LoanRepo(conn)
        self.payments, self.promises, self.contacts = PaymentRepo(conn), PromiseRepo(conn), ContactRepo(conn)
        self.decisions, self.actions = DecisionRepo(conn), ActionRepo(conn)
        self.trace: dict[str, Any] = {"changes": []}
        self.duplicate = False

    def change(self, what: str, **detail) -> None:
        self.trace["changes"].append({"what": what, **detail})

    def customer(self) -> dict:
        c = self.customers.get(self.ev.customer_id)
        if c is None:
            raise EventRejected(f"Cliente desconocido: {self.ev.customer_id}", 404)
        return c

    def installment(self, installment_id: str | None = None) -> dict:
        iid = installment_id or self.ev.installment_id or self.ev.payload.get("installment_id")
        if not iid:
            raise EventRejected("installment_id requerido")
        inst = self.insts.get(iid)
        if inst is None or inst["customer_id"] != self.ev.customer_id:
            raise EventRejected(f"Cuota {iid} inexistente o no pertenece al cliente", 404)
        return inst

    def bump_and_invalidate(self, reason: str, channels: list[str] | None = None, flag: bool = True) -> int:
        """Nuevo estado del expediente: sube case_version e invalida propuestas pendientes (ahora obsoletas)."""
        version = self.customers.bump_version(self.now, self.ev.customer_id)
        stale = self.decisions.invalidate_pending(self.now, self.ev.customer_id, f"{reason} (case_version→{version})", channels)
        self.change("case_version", new=version, reason=reason)
        if stale:
            self.change("decisions_invalidated", decision_ids=stale)
        if flag:
            self.customers.flag_reevaluation(self.now, self.ev.customer_id, reason)
        return version

    def reevaluate(self) -> dict:
        res = scheduling.reevaluate_customer(self.c, self.ev.customer_id, self.now, self.ev.event_type.value,
                                             event_id=self.ev.event_id)
        self.trace["reevaluation"] = {k: res[k] for k in ("created", "kept", "cancelled", "blocked")} | {
            "plan": res["plan"]["action_type"], "hold": res["plan"]["hold"]}
        return res


def _amount_cents(payload: dict) -> int:
    try:
        if "amount_cents" in payload:
            v = payload["amount_cents"]
            if isinstance(v, bool) or not isinstance(v, int):
                raise ValueError("amount_cents debe ser entero")
            return v
        if "amount" in payload:
            return to_cents(payload["amount"])
    except ValueError as exc:
        raise EventRejected(str(exc)) from exc
    raise EventRejected("Falta amount_cents (o amount)")


def _recompute(ctx: Ctx, inst: dict) -> dict:
    """Recalcula cuota y préstamo desde los pagos confirmados (fuente de verdad única, a prueba de reversos)."""
    paid = ctx.payments.confirmed_sum(installment_id=inst["installment_id"])
    status = "PAID" if paid >= inst["amount_cents"] else ("PARTIAL" if paid > 0 else "OPEN")
    ctx.insts.set_paid(ctx.now, inst["installment_id"], paid, status)
    loan = ctx.loans.get(inst["loan_id"])
    outstanding = loan["initial_outstanding_cents"] - ctx.payments.confirmed_sum(loan_id=loan["loan_id"])
    ctx.loans.set_outstanding(ctx.now, loan["loan_id"], max(outstanding, 0), "ACTIVE" if outstanding > 0 else "CLOSED")
    return {"installment_paid_cents": paid, "installment_status": status, "loan_outstanding_cents": outstanding,
            "installment_remaining_cents": max(inst["amount_cents"] - paid, 0)}


def _settle_promises(ctx: Ctx, inst: dict, paid_cents: int) -> None:
    for p in ctx.promises.open_for_installment(inst["installment_id"]):
        since = ctx.payments.confirmed_since(inst["installment_id"], p["created_at"])
        if since >= p["promised_amount_cents"] or paid_cents >= inst["amount_cents"]:
            ctx.promises.set_status(ctx.now, p["promise_id"], "KEPT")
            ctx.change("promise_kept", promise_id=p["promise_id"])


# ------------------------------------------------------------------ handlers
def h_payment_posted(ctx: Ctx) -> None:
    ev, p = ctx.ev, ctx.ev.payload
    if ev.source != "bank_simulator":
        raise EventRejected("Un pago solo se reconoce con evento confirmado del simulador bancario (source=bank_simulator)", 403)
    if str(p.get("bank_status", "CONFIRMED")).upper() != "CONFIRMED":
        raise EventRejected("El simulador bancario no confirmó el pago (bank_status != CONFIRMED)")
    ref = p.get("payment_ref")
    if not ref:
        raise EventRejected("payment_ref requerido")
    ctx.customer()
    inst = ctx.installment()
    loan = ctx.loans.get(inst["loan_id"])
    cents = _amount_cents(p)
    if cents <= 0:
        raise EventRejected("El monto debe ser positivo")
    if p.get("currency", loan["currency"]) != loan["currency"]:
        raise EventRejected(f"Moneda {p.get('currency')} no coincide con la del préstamo ({loan['currency']})")

    existing = ctx.payments.by_ref(ref)
    if existing and existing["status"] == "CONFIRMED":
        ctx.duplicate = True
        ctx.change("duplicate_payment_ignored", payment_ref=ref, payment_id=existing["payment_id"])
        return
    if existing and existing["status"] in ("REVERSED", "FAILED"):
        raise EventRejected(f"payment_ref {ref} ya existe en estado {existing['status']}", 409)
    if inst["status"] == "PAID":
        raise EventRejected("La cuota ya está liquidada", 409)
    remaining = inst["amount_cents"] - inst["paid_cents"]
    if cents > remaining:
        raise EventRejected(f"Monto {fmt_money(cents)} excede el saldo de la cuota ({fmt_money(remaining)})")

    if existing:  # estaba PENDING: ahora confirmado
        if existing["installment_id"] != inst["installment_id"] or existing["amount_cents"] != cents:
            raise EventRejected("La confirmación no coincide con el pago pendiente (cuota/monto)", 409)
        ctx.payments.set_status(ctx.now, existing["payment_id"], "CONFIRMED", source_event_id=ev.event_id)
        pay = existing
        ctx.change("pending_payment_confirmed", payment_id=pay["payment_id"])
    else:
        pay = ctx.payments.insert(ctx.now, payment_ref=ref, customer_id=ev.customer_id, loan_id=loan["loan_id"],
                                  installment_id=inst["installment_id"], amount_cents=cents, currency=loan["currency"],
                                  status="CONFIRMED", source_event_id=ev.event_id, posted_at=ev.occurred_at or ctx.now)
        ctx.change("payment_recorded", payment_id=pay["payment_id"], amount=fmt_money(cents, loan["currency"]))
    res = _recompute(ctx, inst)
    ctx.change("balances_updated", **res)
    _settle_promises(ctx, inst, res["installment_paid_cents"])
    ctx.bump_and_invalidate("Pago confirmado", flag=res["installment_status"] != "PAID")
    if res["installment_status"] == "PAID":
        ctx.change("installment_closed", installment_id=inst["installment_id"])
    ctx.reevaluate()


def h_payment_pending(ctx: Ctx) -> None:
    ev, p = ctx.ev, ctx.ev.payload
    ref = p.get("payment_ref")
    if not ref:
        raise EventRejected("payment_ref requerido")
    ctx.customer()
    inst = ctx.installment()
    loan = ctx.loans.get(inst["loan_id"])
    cents = _amount_cents(p)
    if cents <= 0:
        raise EventRejected("El monto debe ser positivo")
    if p.get("currency", loan["currency"]) != loan["currency"]:
        raise EventRejected("Moneda no coincide con la del préstamo")
    if ctx.payments.by_ref(ref):
        ctx.duplicate = True
        ctx.change("duplicate_pending_ignored", payment_ref=ref)
        return
    if inst["status"] == "PAID":
        raise EventRejected("La cuota ya está liquidada", 409)
    pay = ctx.payments.insert(ctx.now, payment_ref=ref, customer_id=ev.customer_id, loan_id=loan["loan_id"],
                              installment_id=inst["installment_id"], amount_cents=cents, currency=loan["currency"],
                              status="PENDING", source_event_id=ev.event_id, posted_at=ev.occurred_at or ctx.now)
    ctx.change("payment_pending_recorded", payment_id=pay["payment_id"], note="No se descuenta dinero hasta confirmación")
    ctx.customers.flag_reevaluation(ctx.now, ev.customer_id, "Pago pendiente de verificación")
    ctx.reevaluate()


def h_payment_reversed(ctx: Ctx) -> None:
    ev, p = ctx.ev, ctx.ev.payload
    ref = p.get("payment_ref")
    pay = ctx.payments.by_ref(ref) if ref else None
    if pay is None or pay["customer_id"] != ev.customer_id:
        raise EventRejected("Pago inexistente para este cliente", 404)
    if pay["status"] == "REVERSED":
        ctx.duplicate = True
        ctx.change("duplicate_reversal_ignored", payment_ref=ref)
        return
    inst = ctx.insts.get(pay["installment_id"])
    if pay["status"] == "PENDING":  # nunca se contabilizó: solo se descarta
        ctx.payments.set_status(ctx.now, pay["payment_id"], "FAILED")
        ctx.change("pending_payment_failed", payment_id=pay["payment_id"])
        ctx.reevaluate()
        return
    if pay["status"] != "CONFIRMED":
        raise EventRejected(f"No se puede revertir un pago en estado {pay['status']}", 409)
    ctx.payments.set_status(ctx.now, pay["payment_id"], "REVERSED")
    rev = ctx.payments.insert(ctx.now, payment_ref=f"{ref}:REV", customer_id=ev.customer_id, loan_id=pay["loan_id"],
                              installment_id=pay["installment_id"], amount_cents=pay["amount_cents"],
                              currency=pay["currency"], status="CONFIRMED", source_event_id=ev.event_id,
                              posted_at=ev.occurred_at or ctx.now, kind="REVERSAL", reverses_payment_id=pay["payment_id"])
    ctx.change("compensating_entry", reversal_id=rev["payment_id"], reverses=pay["payment_id"])
    res = _recompute(ctx, inst)
    ctx.change("balances_updated", **res)
    ctx.bump_and_invalidate("Pago revertido")
    ctx.reevaluate()


def h_customer_replied(ctx: Ctx) -> None:
    p = ctx.ev.payload
    text, channel = p.get("text"), p.get("channel", "whatsapp")
    if not text or channel not in CHANNELS:
        raise EventRejected("Se requiere text y un channel válido")
    ctx.customer()
    inst = ctx.insts.current_open(ctx.ev.customer_id)
    ConversationRepo(ctx.c).insert(ctx.now, customer_id=ctx.ev.customer_id, thread_id=p.get("thread_id", "default"),
                                   channel=channel, sender="customer", text=text, event_id=ctx.ev.event_id)
    ctx.contacts.insert(ctx.now, customer_id=ctx.ev.customer_id, channel=channel, direction="inbound",
                        outcome="REPLIED", occurred_at=ctx.ev.occurred_at or ctx.now, event_id=ctx.ev.event_id,
                        installment_id=inst["installment_id"] if inst else None)
    last = ctx.contacts.last_outbound(ctx.ev.customer_id)
    if last and last["outcome"] in ("SIMULATED_SENT", "NO_RESPONSE", "DELIVERED"):
        ctx.contacts.set_outcome(last["contact_id"], "RESPONDED")
    ctx.change("conversation_message_recorded", channel=channel)
    ctx.customers.flag_reevaluation(ctx.now, ctx.ev.customer_id, "El cliente respondió: reevaluar con el agente conversacional")
    if OPT_OUT_TEXT.search(text):
        ctx.change("opt_out_keyword_detected", note="El texto contiene BAJA/STOP: se procesa como exclusión voluntaria")
        _apply_opt_out(ctx, [channel], all_channels=False)
        return
    ctx.reevaluate()


def _apply_opt_out(ctx: Ctx, channels: list[str], all_channels: bool) -> None:
    cust = ctx.customer()
    if all_channels:
        ctx.customers.set_fields(ctx.now, cust["customer_id"], opted_out_all=1)
        affected = None
    else:
        merged = sorted(set(cust["opted_out_channels"]) | set(channels))
        ctx.customers.set_fields(ctx.now, cust["customer_id"], opted_out_channels=merged)
        affected = channels
    ctx.change("opt_out_registered", channels="ALL" if all_channels else channels)
    ctx.bump_and_invalidate("Exclusión voluntaria", channels=affected)
    ctx.reevaluate()


def h_opt_out(ctx: Ctx) -> None:
    p = ctx.ev.payload
    ctx.customer()
    channels = p.get("channels")
    all_ch = bool(p.get("all", False)) or channels in (None, [], "ALL")
    if not all_ch:
        if not isinstance(channels, list) or not set(channels) <= CHANNELS:
            raise EventRejected("channels debe ser una lista de canales válidos (o all=true)")
    _apply_opt_out(ctx, [] if all_ch else channels, all_ch)


def h_promise_created(ctx: Ctx) -> None:
    p = ctx.ev.payload
    ctx.customer()
    inst = ctx.installment()
    if inst["status"] == "PAID":
        raise EventRejected("La cuota ya está liquidada", 409)
    cents = _amount_cents(p)
    if cents <= 0 or cents > inst["amount_cents"] - inst["paid_cents"]:
        raise EventRejected("Monto prometido inválido o superior al saldo de la cuota")
    try:
        pdate = date.fromisoformat(p.get("promised_date", ""))
    except ValueError as exc:
        raise EventRejected("promised_date debe ser YYYY-MM-DD") from exc
    for old in ctx.promises.open_for_installment(inst["installment_id"]):
        ctx.promises.set_status(ctx.now, old["promise_id"], "CANCELLED")
        ctx.change("promise_superseded", promise_id=old["promise_id"])
    promise = ctx.promises.insert(ctx.now, customer_id=ctx.ev.customer_id, installment_id=inst["installment_id"],
                                  promised_amount_cents=cents, promised_date=pdate.isoformat(),
                                  source_event_id=ctx.ev.event_id)
    ctx.change("promise_recorded", promise_id=promise["promise_id"], amount=fmt_money(cents),
               promised_date=pdate.isoformat(), note="Una promesa NO es un pago: saldo sin cambios")
    ctx.bump_and_invalidate("Compromiso de pago registrado")
    ctx.reevaluate()


def h_promise_due(ctx: Ctx) -> None:
    p = ctx.ev.payload
    ctx.customer()
    promise = ctx.promises.get(p.get("promise_id", ""))
    if promise is None or promise["customer_id"] != ctx.ev.customer_id:
        raise EventRejected("Promesa inexistente para este cliente", 404)
    if promise["status"] != "OPEN":
        ctx.duplicate = True
        ctx.change("promise_already_resolved", status=promise["status"])
        return
    inst = ctx.insts.get(promise["installment_id"])
    since = ctx.payments.confirmed_since(inst["installment_id"], promise["created_at"])
    if since >= promise["promised_amount_cents"] or inst["status"] == "PAID":
        ctx.promises.set_status(ctx.now, promise["promise_id"], "KEPT")
        ctx.change("promise_kept", promise_id=promise["promise_id"])
        ctx.reevaluate()
    else:
        ctx.promises.set_status(ctx.now, promise["promise_id"], "BROKEN")
        ctx.change("promise_broken", promise_id=promise["promise_id"],
                   paid_since=fmt_money(since), promised=fmt_money(promise["promised_amount_cents"]))
        ctx.bump_and_invalidate("Promesa incumplida")
        ctx.reevaluate()


def h_contact_recorded(ctx: Ctx) -> None:
    p = ctx.ev.payload
    ctx.customer()
    channel, outcome = p.get("channel"), p.get("outcome")
    if channel not in CHANNELS or not outcome:
        raise EventRejected("Se requiere channel válido y outcome")
    inst = ctx.insts.get(p["installment_id"]) if p.get("installment_id") else ctx.insts.current_open(ctx.ev.customer_id)
    row = ctx.contacts.insert(ctx.now, customer_id=ctx.ev.customer_id, channel=channel,
                              direction=p.get("direction", "outbound"), outcome=str(outcome).upper(),
                              occurred_at=ctx.ev.occurred_at or ctx.now, installment_id=inst["installment_id"] if inst else None,
                              action_id=p.get("action_id"), decision_id=p.get("decision_id"), event_id=ctx.ev.event_id,
                              note=p.get("note"))
    ctx.change("contact_recorded", contact_id=row["contact_id"], channel=channel, outcome=row["outcome"])
    aid = p.get("action_id")
    if aid:
        a = ctx.actions.get(aid)
        if a and a["customer_id"] == ctx.ev.customer_id and a["status"] in ("PENDING", "DUE"):
            ctx.actions.set_status(ctx.now, aid, "COMPLETED", "Contacto registrado para esta acción.")
            ctx.change("action_completed", action_id=aid)
    ctx.reevaluate()


def h_dispute(ctx: Ctx) -> None:
    ctx.customer()
    ctx.customers.set_fields(ctx.now, ctx.ev.customer_id, dispute_open=1)
    ctx.change("dispute_opened", reason=ctx.ev.payload.get("reason", ""))
    ctx.bump_and_invalidate("Disputa abierta")
    ctx.reevaluate()


def h_human_review(ctx: Ctx) -> None:
    from .decision_service import DecisionNotFound, ReviewConflict, review_in_tx  # import tardío: evita ciclo
    p = ctx.ev.payload
    if ctx.ev.source != "human":
        raise EventRejected("HUMAN_REVIEW solo puede originarse en un revisor humano (source=human)", 403)
    ctx.customer()
    kind = p.get("kind", "decision_review")
    if kind == "resolve_dispute":
        ctx.customers.set_fields(ctx.now, ctx.ev.customer_id, dispute_open=0)
        ctx.change("dispute_resolved", reviewer=p.get("reviewer_id"), note=p.get("comment", ""))
        ctx.bump_and_invalidate("Disputa resuelta por revisión humana")
        ctx.reevaluate()
    elif kind == "decision_review":
        try:
            out = review_in_tx(ctx.c, ctx.now, p.get("decision_id", ""), p.get("reviewer_id", ""),
                               p.get("action", ""), p.get("comment", ""), actor_role=ctx.ev.source)
        except DecisionNotFound as exc:
            raise EventRejected("Decisión no encontrada", 404) from exc
        except ReviewConflict as exc:
            raise EventRejected(exc.message, exc.status) from exc
        ctx.change("decision_reviewed", **out)
    else:
        raise EventRejected(f"kind desconocido: {kind}")


def h_investigate(ctx: Ctx) -> None:
    ctx.customer()
    reason = ctx.ev.payload.get("reason", "Solicitud de investigación")
    ctx.customers.flag_reevaluation(ctx.now, ctx.ev.customer_id, f"INVESTIGATE: {reason}")
    ctx.change("reevaluation_requested", reason=reason)
    ctx.reevaluate()


HANDLERS = {
    "PAYMENT_POSTED": h_payment_posted, "PAYMENT_PENDING": h_payment_pending, "PAYMENT_REVERSED": h_payment_reversed,
    "CUSTOMER_REPLIED": h_customer_replied, "PROMISE_CREATED": h_promise_created, "PROMISE_DUE": h_promise_due,
    "CONTACT_RECORDED": h_contact_recorded, "CONTACT_OPT_OUT": h_opt_out, "DISPUTE_OPENED": h_dispute,
    "HUMAN_REVIEW": h_human_review, "INVESTIGATE": h_investigate,
}


def _result(ev_row: dict, replay: bool) -> dict:
    import json
    return {"event_id": ev_row["event_id"], "event_type": ev_row["event_type"], "status": ev_row["status"],
            "reason": ev_row["reason"], "idempotent_replay": replay, "case_version": ev_row["case_version_after"],
            "trace": json.loads(ev_row["trace_json"])}


def process_event(conn: sqlite3.Connection, ev: EventIn, now: datetime | None = None) -> dict:
    """Procesa un evento de forma atómica e idempotente. Lanza EventRejected (tras registrar el rechazo)."""
    ev.source = ev.source or "system"
    # Autorización ANTES de cualquier lectura/escritura: un evento no autorizado no deja rastro en la BD
    # (los intentos denegados se registran solo en el log, sin payload ni credenciales).
    if not event_allowed(ev.event_type.value, ev.source):
        raise EventRejected(f"El origen '{ev.source}' no está autorizado para registrar {ev.event_type.value}", 403, audit=False)
    now = ev.occurred_at.astimezone(utcnow().tzinfo) if ev.occurred_at else (now or utcnow())
    events = EventRepo(conn)
    prior = events.get(ev.event_id)
    if prior:
        return _result(prior, replay=True)

    try:
        with transaction(conn):
            if events.get(ev.event_id):  # carrera: otro proceso lo registró
                prior = events.get(ev.event_id)
            else:
                ctx = Ctx(conn, ev, now)
                HANDLERS[ev.event_type.value](ctx)
                cust = ctx.customers.get(ev.customer_id)
                status = "DUPLICATE" if ctx.duplicate else "PROCESSED"
                events.insert(now, event_id=ev.event_id, event_type=ev.event_type.value, source=ev.source,
                              customer_id=ev.customer_id, installment_id=ev.installment_id or ev.payload.get("installment_id"),
                              payload=ev.payload, status=status, reason=None, trace=ctx.trace,
                              case_version_after=cust["case_version"], occurred_at=ev.occurred_at or now)
    except EventRejected as rej:
        if rej.status == 403 or not rej.audit:  # denegaciones de autorización: sin escritura en la BD
            raise
        with transaction(conn):  # el rechazo también queda auditado
            if not events.get(ev.event_id):
                events.insert(now, event_id=ev.event_id, event_type=ev.event_type.value, source=ev.source,
                              customer_id=ev.customer_id, installment_id=ev.installment_id, payload=ev.payload,
                              status="REJECTED", reason=rej.reason, trace={"changes": []}, case_version_after=None,
                              occurred_at=ev.occurred_at or now)
        raise
    return _result(events.get(ev.event_id), replay=prior is not None)
