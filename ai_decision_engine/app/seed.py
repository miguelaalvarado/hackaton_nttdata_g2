"""Datos de demostración 100% ficticios (sin información de entidades reales)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta

from . import scheduling
from .calendar_pe import LIMA
from .db import transaction, utcnow
from .repositories import CustomerRepo, InstallmentRepo, LoanRepo

DEMO = [
    # id, nombre, producto, moneda, saldo, cuota, días hasta vencer (negativo = vencida), canales, preferido
    ("CLI-0001", "Lucía", "credit_card", "PEN", 5200_00, 450_00, 10, ["sms", "email", "whatsapp", "push", "phone_call"], None),
    ("CLI-0002", "Carlos", "personal_loan", "PEN", 12000_00, 800_00, 2, ["sms", "whatsapp", "email"], "whatsapp"),
    ("CLI-0003", "Marta", "auto_loan", "USD", 9500_00, 420_00, -3, ["email", "phone_call", "sms"], None),
    ("CLI-0004", "Jorge", "mortgage", "PEN", 90000_00, 2400_00, -10, ["phone_call", "whatsapp", "email"], None),
]


def seed_demo(conn: sqlite3.Connection, now: datetime | None = None) -> dict:
    """Idempotente: no toca clientes que ya existen."""
    now = now or utcnow()
    today = now.astimezone(LIMA).date()
    customers, loans, insts = CustomerRepo(conn), LoanRepo(conn), InstallmentRepo(conn)
    created = []
    with transaction(conn):
        for cid, name, product, cur, balance, amount, days, consent, pref in DEMO:
            if customers.get(cid):
                continue
            customers.create(now, cid, name, "es", consent, pref)
            loan = loans.create(now, cid, product, cur, balance, loan_id=f"LN-{cid[-4:]}")
            for seq in (1, 2, 3):
                due = today + timedelta(days=days + 30 * (seq - 1))
                insts.create(now, loan["loan_id"], cid, seq, due.isoformat(), amount, installment_id=f"IN-{cid[-4:]}-{seq}")
            created.append(cid)
        for cid in created:
            scheduling.reevaluate_customer(conn, cid, now, "SEED")
    return {"created": created, "existing": [d[0] for d in DEMO if d[0] not in created]}
