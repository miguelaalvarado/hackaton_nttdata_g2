"""Capa de repositorios: único lugar con SQL. Cada repo recibe una conexión (la transacción la gobierna el servicio)."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from .db import dumps, new_id, to_iso


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def _rows(rs) -> list[dict]:
    return [dict(r) for r in rs]


class Repo:
    def __init__(self, conn: sqlite3.Connection):
        self.c = conn

    def _update(self, table: str, pk: str, pk_val: str, now: datetime, **fields) -> None:
        fields["updated_at"] = to_iso(now)
        cols = ", ".join(f"{k}=?" for k in fields)
        self.c.execute(f"UPDATE {table} SET {cols} WHERE {pk}=?", (*fields.values(), pk_val))


# ------------------------------------------------------------------ customers
class CustomerRepo(Repo):
    def get(self, customer_id: str) -> dict | None:
        r = _row(self.c.execute("SELECT * FROM customers WHERE customer_id=?", (customer_id,)).fetchone())
        if r:
            for k in ("consent_channels", "opted_out_channels"):
                r[k] = json.loads(r[k])
        return r

    def list(self) -> list[dict]:
        ids = [r["customer_id"] for r in self.c.execute("SELECT customer_id FROM customers ORDER BY customer_id")]
        return [self.get(i) for i in ids]

    def create(self, now: datetime, customer_id: str, first_name: str, language: str = "es",
               consent_channels: list[str] | None = None, preferred_channel: str | None = None) -> dict:
        ts = to_iso(now)
        self.c.execute(
            "INSERT INTO customers(customer_id,first_name,language,consent_channels,preferred_channel,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (customer_id, first_name, language, dumps(consent_channels or []), preferred_channel, ts, ts))
        return self.get(customer_id)

    def bump_version(self, now: datetime, customer_id: str) -> int:
        self.c.execute("UPDATE customers SET case_version=case_version+1, updated_at=? WHERE customer_id=?",
                       (to_iso(now), customer_id))
        return self.c.execute("SELECT case_version FROM customers WHERE customer_id=?", (customer_id,)).fetchone()[0]

    def set_fields(self, now: datetime, customer_id: str, **fields) -> None:
        for k in ("consent_channels", "opted_out_channels"):
            if k in fields:
                fields[k] = dumps(fields[k])
        self._update("customers", "customer_id", customer_id, now, **fields)

    def flag_reevaluation(self, now: datetime, customer_id: str, reason: str) -> None:
        self._update("customers", "customer_id", customer_id, now, needs_reevaluation=1, reevaluation_reason=reason)

    def clear_reevaluation(self, now: datetime, customer_id: str) -> None:
        self._update("customers", "customer_id", customer_id, now, needs_reevaluation=0, reevaluation_reason=None)

    def needing_reevaluation(self) -> list[dict]:
        ids = [r[0] for r in self.c.execute(
            "SELECT customer_id FROM customers WHERE needs_reevaluation=1 ORDER BY updated_at")]
        return [self.get(i) for i in ids]


# ------------------------------------------------------------ loans / cuotas
class LoanRepo(Repo):
    def get(self, loan_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM loans WHERE loan_id=?", (loan_id,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM loans WHERE customer_id=? ORDER BY created_at", (customer_id,)))

    def create(self, now: datetime, customer_id: str, product: str, currency: str, outstanding_cents: int,
               loan_id: str | None = None) -> dict:
        loan_id = loan_id or new_id("LN")
        ts = to_iso(now)
        self.c.execute("INSERT INTO loans VALUES (?,?,?,?,?,?,?,?,?)",
                       (loan_id, customer_id, product, currency, outstanding_cents, outstanding_cents, "ACTIVE", ts, ts))
        return self.get(loan_id)

    def set_outstanding(self, now: datetime, loan_id: str, outstanding_cents: int, status: str) -> None:
        self._update("loans", "loan_id", loan_id, now, outstanding_cents=outstanding_cents, status=status)


class InstallmentRepo(Repo):
    def get(self, installment_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM installments WHERE installment_id=?", (installment_id,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute(
            "SELECT * FROM installments WHERE customer_id=? ORDER BY due_date, sequence", (customer_id,)))

    def current_open(self, customer_id: str) -> dict | None:
        """Cuota abierta más antigua (la que gobierna la gestión de cobranza)."""
        return _row(self.c.execute(
            "SELECT * FROM installments WHERE customer_id=? AND status!='PAID' ORDER BY due_date, sequence LIMIT 1",
            (customer_id,)).fetchone())

    def create(self, now: datetime, loan_id: str, customer_id: str, sequence: int, due_date: str,
               amount_cents: int, installment_id: str | None = None) -> dict:
        installment_id = installment_id or new_id("IN")
        ts = to_iso(now)
        self.c.execute("INSERT INTO installments VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (installment_id, loan_id, customer_id, sequence, due_date, amount_cents, 0, "OPEN", None, ts, ts))
        return self.get(installment_id)

    def set_paid(self, now: datetime, installment_id: str, paid_cents: int, status: str) -> None:
        closed = to_iso(now) if status == "PAID" else None
        self._update("installments", "installment_id", installment_id, now,
                     paid_cents=paid_cents, status=status, closed_at=closed)


# --------------------------------------------------------------------- pagos
class PaymentRepo(Repo):
    def get(self, payment_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM payments WHERE payment_id=?", (payment_id,)).fetchone())

    def by_ref(self, payment_ref: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM payments WHERE payment_ref=?", (payment_ref,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM payments WHERE customer_id=? ORDER BY posted_at, created_at",
                                    (customer_id,)))

    def pending_for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM payments WHERE customer_id=? AND status='PENDING'", (customer_id,)))

    def pending_for_installment(self, installment_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM payments WHERE installment_id=? AND status='PENDING'",
                                    (installment_id,)))

    def confirmed_sum(self, installment_id: str | None = None, loan_id: str | None = None) -> int:
        col, val = ("installment_id", installment_id) if installment_id else ("loan_id", loan_id)
        return self.c.execute(
            f"SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE {col}=? AND kind='PAYMENT' AND status='CONFIRMED'",
            (val,)).fetchone()[0]

    def confirmed_since(self, installment_id: str, since_iso: str) -> int:
        return self.c.execute(
            "SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE installment_id=? AND kind='PAYMENT'"
            " AND status='CONFIRMED' AND posted_at>=?", (installment_id, since_iso)).fetchone()[0]

    def insert(self, now: datetime, *, payment_ref: str, customer_id: str, loan_id: str, installment_id: str,
               amount_cents: int, currency: str, status: str, source_event_id: str, posted_at: datetime,
               kind: str = "PAYMENT", reverses_payment_id: str | None = None) -> dict:
        pid = new_id("PAY")
        ts = to_iso(now)
        self.c.execute("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (pid, payment_ref, customer_id, loan_id, installment_id, kind, amount_cents, currency, status,
                        reverses_payment_id, source_event_id, to_iso(posted_at), ts, ts))
        return self.get(pid)

    def set_status(self, now: datetime, payment_id: str, status: str, **extra) -> None:
        self._update("payments", "payment_id", payment_id, now, status=status, **extra)


# ------------------------------------------------- contactos / conversaciones
class ContactRepo(Repo):
    def insert(self, now: datetime, *, customer_id: str, channel: str, direction: str, outcome: str,
               occurred_at: datetime, installment_id: str | None = None, action_id: str | None = None,
               decision_id: str | None = None, event_id: str | None = None, note: str | None = None) -> dict:
        cid = new_id("CT")
        self.c.execute("INSERT INTO contact_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (cid, customer_id, installment_id, channel, direction, outcome, to_iso(occurred_at),
                        action_id, decision_id, event_id, note, to_iso(now)))
        return _row(self.c.execute("SELECT * FROM contact_history WHERE contact_id=?", (cid,)).fetchone())

    def for_customer(self, customer_id: str, limit: int | None = None) -> list[dict]:
        q = "SELECT * FROM contact_history WHERE customer_id=? ORDER BY occurred_at DESC, created_at DESC"
        return _rows(self.c.execute(q + (f" LIMIT {int(limit)}" if limit else ""), (customer_id,)))

    def outbound_since(self, customer_id: str, since_iso: str) -> list[dict]:
        return _rows(self.c.execute(
            "SELECT * FROM contact_history WHERE customer_id=? AND direction='outbound' AND occurred_at>=?"
            " ORDER BY occurred_at", (customer_id, since_iso)))

    def last_outbound(self, customer_id: str) -> dict | None:
        return _row(self.c.execute(
            "SELECT * FROM contact_history WHERE customer_id=? AND direction='outbound'"
            " ORDER BY occurred_at DESC, created_at DESC LIMIT 1", (customer_id,)).fetchone())

    def last_replied_channel(self, customer_id: str) -> str | None:
        r = self.c.execute(
            "SELECT channel FROM contact_history WHERE customer_id=? AND direction='inbound'"
            " ORDER BY occurred_at DESC LIMIT 1", (customer_id,)).fetchone()
        return r[0] if r else None

    def set_outcome(self, contact_id: str, outcome: str) -> None:
        self.c.execute("UPDATE contact_history SET outcome=? WHERE contact_id=?", (outcome, contact_id))


class ConversationRepo(Repo):
    def insert(self, now: datetime, *, customer_id: str, thread_id: str, channel: str, sender: str, text: str,
               event_id: str | None = None) -> dict:
        cid = new_id("CV")
        self.c.execute("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?)",
                       (cid, thread_id, customer_id, channel, sender, text, event_id, to_iso(now)))
        return _row(self.c.execute("SELECT * FROM conversations WHERE conversation_id=?", (cid,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM conversations WHERE customer_id=? ORDER BY created_at",
                                    (customer_id,)))


class PromiseRepo(Repo):
    def get(self, promise_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM promises WHERE promise_id=?", (promise_id,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM promises WHERE customer_id=? ORDER BY created_at", (customer_id,)))

    def open_for_installment(self, installment_id: str) -> list[dict]:
        return _rows(self.c.execute(
            "SELECT * FROM promises WHERE installment_id=? AND status='OPEN' ORDER BY created_at", (installment_id,)))

    def insert(self, now: datetime, *, customer_id: str, installment_id: str, promised_amount_cents: int,
               promised_date: str, source_event_id: str) -> dict:
        pid = new_id("PR")
        ts = to_iso(now)
        self.c.execute("INSERT INTO promises VALUES (?,?,?,?,?,?,?,?,?)",
                       (pid, customer_id, installment_id, promised_amount_cents, promised_date, "OPEN",
                        source_event_id, ts, ts))
        return self.get(pid)

    def set_status(self, now: datetime, promise_id: str, status: str) -> None:
        self._update("promises", "promise_id", promise_id, now, status=status)


# ----------------------------------------------------------------- decisiones
class DecisionRepo(Repo):
    def get(self, decision_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM decisions WHERE decision_id=?", (decision_id,)).fetchone())

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM decisions WHERE customer_id=? ORDER BY created_at DESC",
                                    (customer_id,)))

    def pending_for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute(
            "SELECT * FROM decisions WHERE customer_id=? AND review_status='pending' AND validity='valid'"
            " ORDER BY created_at DESC", (customer_id,)))

    def insert(self, now: datetime, *, decision_id: str, request_id: str, customer_id: str,
               installment_id: str | None, source: str, agent_id: str | None, proposal_id: str | None,
               case_version: int, compliance_status: str, channel: str | None, payload_json: str) -> None:
        ts = to_iso(now)
        self.c.execute(
            "INSERT INTO decisions(decision_id,request_id,customer_id,installment_id,source,agent_id,proposal_id,"
            "case_version,compliance_status,channel,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (decision_id, request_id, customer_id, installment_id, source, agent_id, proposal_id, case_version,
             compliance_status, channel, payload_json, ts, ts))

    def set_review(self, now: datetime, decision_id: str, status: str, reviewer_id: str, comment: str) -> None:
        self._update("decisions", "decision_id", decision_id, now, review_status=status, reviewer_id=reviewer_id,
                     review_comment=comment, reviewed_at=to_iso(now))

    def invalidate_pending(self, now: datetime, customer_id: str, reason: str, channels: list[str] | None = None) -> list[str]:
        """Marca como obsoletas las propuestas pendientes del cliente (no toca decisiones ya aprobadas/rechazadas)."""
        rows = self.pending_for_customer(customer_id)
        ids = [r["decision_id"] for r in rows if channels is None or r["channel"] in channels]
        for did in ids:
            self._update("decisions", "decision_id", did, now, validity="stale", stale_reason=reason)
        return ids


# ------------------------------------------------------------ acciones agenda
class ActionRepo(Repo):
    ACTIVE = ("PENDING", "DUE", "BLOCKED")

    def get(self, action_id: str) -> dict | None:
        return _row(self.c.execute("SELECT * FROM scheduled_actions WHERE action_id=?", (action_id,)).fetchone())

    def active_for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute(
            "SELECT * FROM scheduled_actions WHERE customer_id=? AND status IN ('PENDING','DUE','BLOCKED')"
            " ORDER BY scheduled_at", (customer_id,)))

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM scheduled_actions WHERE customer_id=? ORDER BY created_at DESC",
                                    (customer_id,)))

    def list(self, status: str | None = None, customer_id: str | None = None) -> list[dict]:
        q, args = "SELECT * FROM scheduled_actions WHERE 1=1", []
        if status:
            q += " AND status=?"; args.append(status)
        if customer_id:
            q += " AND customer_id=?"; args.append(customer_id)
        return _rows(self.c.execute(q + " ORDER BY scheduled_at", args))

    def insert(self, now: datetime, *, customer_id: str, installment_id: str | None, action_type: str,
               channel: str | None, scheduled_at: datetime, reason: str, case_version: int,
               decision_id: str | None, policy_json: str, status: str = "PENDING",
               responsible_agent: str = "followup_learning") -> dict:
        aid = new_id("ACT")
        ts = to_iso(now)
        self.c.execute(
            "INSERT INTO scheduled_actions(action_id,customer_id,installment_id,action_type,channel,scheduled_at,reason,"
            "status,case_version,decision_id,responsible_agent,policy_json,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (aid, customer_id, installment_id, action_type, channel, to_iso(scheduled_at), reason, status,
             case_version, decision_id, responsible_agent, policy_json, ts, ts))
        return self.get(aid)

    def set_status(self, now: datetime, action_id: str, status: str, status_reason: str, **extra) -> None:
        self._update("scheduled_actions", "action_id", action_id, now, status=status, status_reason=status_reason, **extra)


# ------------------------------------------------------- eventos y agent_runs
class EventRepo(Repo):
    def get(self, event_id: str) -> dict | None:
        r = _row(self.c.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone())
        return r

    def for_customer(self, customer_id: str) -> list[dict]:
        return _rows(self.c.execute("SELECT * FROM events WHERE customer_id=? ORDER BY received_at, rowid",
                                    (customer_id,)))

    def insert(self, now: datetime, *, event_id: str, event_type: str, source: str, customer_id: str,
               installment_id: str | None, payload: dict, status: str, reason: str | None, trace: dict,
               case_version_after: int | None, occurred_at: datetime) -> None:
        self.c.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (event_id, event_type, source, customer_id, installment_id, dumps(payload), status, reason,
                        dumps(trace), case_version_after, to_iso(occurred_at), to_iso(now)))


class AgentRunRepo(Repo):
    def insert(self, started: datetime, finished: datetime, *, agent_name: str, customer_id: str | None,
               case_version: int | None, trigger: str | None, status: str, input: dict, output: dict,
               decision_id: str | None = None, event_id: str | None = None) -> str:
        rid = new_id("RUN")
        self.c.execute("INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (rid, agent_name, customer_id, case_version, trigger, status, dumps(input), dumps(output),
                        decision_id, event_id, to_iso(started), to_iso(finished)))
        return rid

    def list(self, customer_id: str | None = None, limit: int = 200) -> list[dict]:
        q, args = "SELECT * FROM agent_runs", []
        if customer_id:
            q += " WHERE customer_id=?"; args.append(customer_id)
        return _rows(self.c.execute(q + f" ORDER BY started_at DESC, rowid DESC LIMIT {int(limit)}", args))


class PolicyRepo(Repo):
    def all(self) -> dict:
        return {r["key"]: json.loads(r["value_json"]) for r in self.c.execute("SELECT * FROM policy_config")}

    def set(self, now: datetime, key: str, value, updated_by: str) -> None:
        self.c.execute("INSERT INTO policy_config VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET"
                       " value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                       (key, dumps(value), to_iso(now), updated_by))
