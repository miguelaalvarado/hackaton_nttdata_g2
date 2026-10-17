"""Persistencia SQLite (MVP local): conexión, esquema y migración mínima.

- Una única base (`NEXO_DB_PATH`, por defecto `data/nexo.db`) es la fuente de verdad del estado financiero.
- Importes monetarios: SIEMPRE centavos enteros (`*_cents`), nunca float.
- Timestamps: texto ISO-8601 en UTC con offset (`2026-10-17T15:00:00+00:00`), ordenables lexicográficamente.
- Transacciones explícitas (`BEGIN IMMEDIATE`) para que cada cambio relevante sea atómico y trazable.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "nexo.db"
SCHEMA_VERSION = 1

EVENT_TYPES = (
    "INVESTIGATE", "PAYMENT_POSTED", "PAYMENT_PENDING", "PAYMENT_REVERSED", "CUSTOMER_REPLIED",
    "PROMISE_CREATED", "PROMISE_DUE", "CONTACT_RECORDED", "CONTACT_OPT_OUT", "DISPUTE_OPENED", "HUMAN_REVIEW",
)
ACTION_STATUSES = ("PENDING", "DUE", "COMPLETED", "CANCELLED", "BLOCKED", "EXPIRED")


def _in(values) -> str:
    return ",".join(f"'{v}'" for v in values)


SCHEMA = f"""
CREATE TABLE IF NOT EXISTS schema_migrations(
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS customers(
  customer_id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'es' CHECK(language IN ('es','en')),
  consent_channels TEXT NOT NULL DEFAULT '[]',
  preferred_channel TEXT,
  opted_out_channels TEXT NOT NULL DEFAULT '[]',
  opted_out_all INTEGER NOT NULL DEFAULT 0 CHECK(opted_out_all IN (0,1)),
  dispute_open INTEGER NOT NULL DEFAULT 0 CHECK(dispute_open IN (0,1)),
  case_version INTEGER NOT NULL DEFAULT 1 CHECK(case_version >= 1),
  needs_reevaluation INTEGER NOT NULL DEFAULT 0 CHECK(needs_reevaluation IN (0,1)),
  reevaluation_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS loans(
  loan_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  product TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('PEN','USD')),
  initial_outstanding_cents INTEGER NOT NULL CHECK(initial_outstanding_cents >= 0),
  outstanding_cents INTEGER NOT NULL CHECK(outstanding_cents >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','CLOSED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS installments(
  installment_id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(loan_id),
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  sequence INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PARTIAL','PAID')),
  closed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(loan_id, sequence));

CREATE TABLE IF NOT EXISTS payments(
  payment_id TEXT PRIMARY KEY,
  payment_ref TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  loan_id TEXT NOT NULL REFERENCES loans(loan_id),
  installment_id TEXT NOT NULL REFERENCES installments(installment_id),
  kind TEXT NOT NULL DEFAULT 'PAYMENT' CHECK(kind IN ('PAYMENT','REVERSAL')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','CONFIRMED','REVERSED','FAILED')),
  reverses_payment_id TEXT REFERENCES payments(payment_id),
  source_event_id TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS contact_history(
  contact_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  installment_id TEXT REFERENCES installments(installment_id),
  channel TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('outbound','inbound')),
  outcome TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  action_id TEXT, decision_id TEXT, event_id TEXT, note TEXT,
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS conversations(
  conversation_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  channel TEXT NOT NULL,
  sender TEXT NOT NULL CHECK(sender IN ('customer','agent')),
  text TEXT NOT NULL,
  event_id TEXT,
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS promises(
  promise_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  installment_id TEXT NOT NULL REFERENCES installments(installment_id),
  promised_amount_cents INTEGER NOT NULL CHECK(promised_amount_cents > 0),
  promised_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','KEPT','BROKEN','CANCELLED')),
  source_event_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS decisions(
  decision_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  installment_id TEXT REFERENCES installments(installment_id),
  source TEXT NOT NULL CHECK(source IN ('engine','agent_proposal')),
  agent_id TEXT, proposal_id TEXT,
  case_version INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
  validity TEXT NOT NULL DEFAULT 'valid' CHECK(validity IN ('valid','stale')),
  stale_reason TEXT,
  compliance_status TEXT NOT NULL,
  channel TEXT,
  reviewer_id TEXT, review_comment TEXT, reviewed_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS scheduled_actions(
  action_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  installment_id TEXT REFERENCES installments(installment_id),
  action_type TEXT NOT NULL,
  channel TEXT,
  scheduled_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ({_in(ACTION_STATUSES)})),
  status_reason TEXT,
  case_version INTEGER NOT NULL,
  decision_id TEXT REFERENCES decisions(decision_id),
  responsible_agent TEXT NOT NULL DEFAULT 'followup_learning',
  policy_json TEXT NOT NULL DEFAULT '{{}}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events(
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ({_in(EVENT_TYPES)})),
  source TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  installment_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{{}}',
  status TEXT NOT NULL CHECK(status IN ('PROCESSED','DUPLICATE','REJECTED')),
  reason TEXT,
  trace_json TEXT NOT NULL DEFAULT '{{}}',
  case_version_after INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS agent_runs(
  run_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(customer_id),
  case_version INTEGER,
  trigger TEXT,
  status TEXT NOT NULL CHECK(status IN ('OK','ERROR','SKIPPED')),
  input_json TEXT NOT NULL DEFAULT '{{}}',
  output_json TEXT NOT NULL DEFAULT '{{}}',
  decision_id TEXT, event_id TEXT,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS policy_config(
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS ix_installments_customer ON installments(customer_id, status);
CREATE INDEX IF NOT EXISTS ix_payments_inst ON payments(installment_id, status);
CREATE INDEX IF NOT EXISTS ix_contact_customer ON contact_history(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_decisions_customer ON decisions(customer_id, review_status);
CREATE INDEX IF NOT EXISTS ix_actions_customer ON scheduled_actions(customer_id, status);
CREATE INDEX IF NOT EXISTS ix_events_customer ON events(customer_id, received_at);
CREATE INDEX IF NOT EXISTS ix_runs_customer ON agent_runs(customer_id, started_at);
"""

_init_lock = threading.Lock()
_initialized: set[str] = set()


def db_path() -> str:
    return os.getenv("NEXO_DB_PATH", str(DEFAULT_DB))


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        raise ValueError("Timestamp sin zona horaria")
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def from_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str, sort_keys=True)


def to_cents(value) -> int:
    """Convierte un importe (str/int/float/Decimal) a centavos enteros sin errores de float."""
    try:
        d = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError(f"Importe inválido: {value!r}") from exc
    cents = d * 100
    if cents != cents.to_integral_value():
        raise ValueError(f"Importe con más de 2 decimales: {value!r}")
    return int(cents)


def fmt_money(cents: int, currency: str = "PEN") -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}{currency} {abs(cents) // 100:,}.{abs(cents) % 100:02d}"


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    if not conn.execute("SELECT 1 FROM schema_migrations WHERE version=?", (SCHEMA_VERSION,)).fetchone():
        conn.execute("INSERT INTO schema_migrations VALUES (?,?,?)",
                     (SCHEMA_VERSION, to_iso(utcnow()), "Esquema inicial: estado financiero, eventos, acciones, decisiones"))


def _open(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    if path != ":memory:":
        conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def connect(path: str | None = None):
    """Conexión por operación (barata en SQLite). El esquema se crea/migra una vez por archivo."""
    path = path or db_path()
    conn = _open(path)
    try:
        key = os.path.abspath(path) if path != ":memory:" else None
        if key is None or key not in _initialized:
            with _init_lock:
                _init(conn)
                if key:
                    _initialized.add(key)
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Transacción atómica: o se aplica todo (cambio + traza) o nada."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
