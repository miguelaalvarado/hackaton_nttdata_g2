"""Follow-up & Scheduling Engine: determina la PRÓXIMA acción permitida y su momento.

- No envía nada: ejecutar una acción solo registra un contacto SIMULADO en `contact_history`.
- Los umbrales (intervalos, límites de frecuencia, ventanas) son supuestos de trabajo CONFIGURABLES
  (tabla `policy_config`), no reglas legales. Cada acción guarda un snapshot de la política aplicada.
- Una única función (`reevaluate_customer`) decide; se usa tanto tras cada evento como al revalidar antes de ejecutar.
"""
from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, time, timedelta, timezone

from .calendar_pe import LIMA, is_business_day
from .compliance import BUSINESS_DAY_CHANNELS
from .db import dumps, from_iso, to_iso, utcnow
from .repositories import (
    ActionRepo, AgentRunRepo, ContactRepo, CustomerRepo, DecisionRepo, InstallmentRepo, LoanRepo, PaymentRepo,
    PolicyRepo, PromiseRepo,
)

AGENT_NAME = "followup_learning"
DEFAULT_CHANNEL_ORDER = ["push", "email", "sms", "whatsapp", "phone_call"]
EPOCH = datetime(2000, 1, 3, tzinfo=timezone.utc)
BAD_OUTCOMES = {"NO_RESPONSE", "FAILED", "BOUNCED"}


@dataclass
class Policy:
    """Parámetros de seguimiento. Valores por defecto = supuestos de trabajo, a validar con Cumplimiento."""
    min_hours_between_contacts: int = 48
    max_contacts_per_7d: int = 3
    contact_window_start: int = 8          # hora local America/Lima (inclusive)
    contact_window_end: int = 20           # exclusive; alineado con compliance.CONTACT_WINDOW
    reminder_lead_days: int = 5            # recordatorio previo al vencimiento
    escalate_after_days_overdue: int = 7   # a partir de aquí: llamada de asesor
    promise_grace_days: int = 1            # espera tras la fecha prometida antes de volver a contactar
    action_expiry_hours: int = 24          # una acción no ejecutada vence tras este lapso
    rotate_channel_after_no_response: bool = True

    def snapshot(self) -> dict:
        return asdict(self)


def load_policy(conn: sqlite3.Connection) -> Policy:
    stored = PolicyRepo(conn).all()
    known = {f.name for f in fields(Policy)}
    return Policy(**{k: v for k, v in stored.items() if k in known})


def save_policy(conn: sqlite3.Connection, now: datetime, changes: dict, updated_by: str) -> Policy:
    known = {f.name: f.type for f in fields(Policy)}
    for k, v in changes.items():
        if k not in known:
            raise ValueError(f"Parámetro de política desconocido: {k}")
        if k == "rotate_channel_after_no_response":
            if not isinstance(v, bool):
                raise ValueError(f"{k} debe ser booleano")
        elif not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError(f"{k} debe ser un entero >= 0")
    if "contact_window_start" in changes or "contact_window_end" in changes:
        cur = asdict(load_policy(conn)) | changes
        if not (0 <= cur["contact_window_start"] < cur["contact_window_end"] <= 24):
            raise ValueError("Ventana de contacto inválida")
    repo = PolicyRepo(conn)
    for k, v in changes.items():
        repo.set(now, k, v, updated_by)
    return load_policy(conn)


# -------------------------------------------------------------------- tiempo
def _lima(dt: datetime) -> datetime:
    return dt.astimezone(LIMA)


def align_to_window(dt: datetime, channel: str | None, policy: Policy) -> datetime:
    """Desplaza `dt` hacia adelante hasta una hora permitida (ventana local; día hábil si el canal lo exige)."""
    loc = _lima(dt)
    for _ in range(30):
        if loc.hour < policy.contact_window_start:
            loc = datetime.combine(loc.date(), time(policy.contact_window_start), tzinfo=LIMA)
        elif loc.hour >= policy.contact_window_end:
            loc = datetime.combine(loc.date() + timedelta(days=1), time(policy.contact_window_start), tzinfo=LIMA)
        if channel in BUSINESS_DAY_CHANNELS and not is_business_day(loc.date()):
            loc = datetime.combine(loc.date() + timedelta(days=1), time(policy.contact_window_start), tzinfo=LIMA)
            continue
        break
    return loc.astimezone(timezone.utc)


def _window_start(d: date, policy: Policy) -> datetime:
    return datetime.combine(d, time(policy.contact_window_start), tzinfo=LIMA).astimezone(timezone.utc)


# ---------------------------------------------------------------------- plan
@dataclass
class Plan:
    action_type: str | None = None
    installment_id: str | None = None
    channel: str | None = None
    earliest: datetime | None = None       # piso permitido por las reglas (sin considerar "ahora")
    scheduled_at: datetime | None = None   # max(earliest, ahora), alineado a ventana
    reason: str = ""
    hold: str | None = None                # motivo de suspensión temporal (disputa/pago pendiente)
    decision_id: str | None = None
    constraints: list[str] = field(default_factory=list)

    def public(self) -> dict:
        d = asdict(self)
        for k in ("earliest", "scheduled_at"):
            d[k] = to_iso(d[k]) if d[k] else None
        return d


def allowed_channels(customer: dict) -> list[str]:
    if customer["opted_out_all"]:
        return []
    return [c for c in customer["consent_channels"] if c not in customer["opted_out_channels"]]


def _order_channels(allowed: list[str], customer: dict, contacts: ContactRepo, policy: Policy,
                    prefer_phone: bool) -> list[str]:
    order: list[str] = []
    if prefer_phone:
        order += ["phone_call", "whatsapp"]
    if customer["preferred_channel"]:
        order.append(customer["preferred_channel"])
    replied = contacts.last_replied_channel(customer["customer_id"])
    if replied:
        order.append(replied)
    order += DEFAULT_CHANNEL_ORDER
    seen, ranked = set(), []
    for ch in order:
        if ch in allowed and ch not in seen:
            seen.add(ch); ranked.append(ch)
    last = contacts.last_outbound(customer["customer_id"])
    if (policy.rotate_channel_after_no_response and last and last["outcome"] in BAD_OUTCOMES
            and last["channel"] in ranked and len(ranked) > 1):
        ranked.remove(last["channel"]); ranked.append(last["channel"])
    return ranked


def plan_next_action(conn: sqlite3.Connection, customer_id: str, now: datetime, policy: Policy,
                     hint: dict | None = None) -> Plan:
    """Decide la próxima acción. `hint` = decisión aprobada (canal/momento propuestos y validados por un humano)."""
    customers, insts, contacts = CustomerRepo(conn), InstallmentRepo(conn), ContactRepo(conn)
    customer = customers.get(customer_id)
    inst = insts.current_open(customer_id)
    if inst is None:
        return Plan(reason="Sin cuotas abiertas: no hay gestión pendiente.")
    base = dict(installment_id=inst["installment_id"])

    if customer["dispute_open"]:
        t = align_to_window(now, None, policy)
        return Plan(action_type="HUMAN_REVIEW", earliest=t, scheduled_at=t, hold="DISPUTE_OPEN",
                    reason="Disputa abierta: se suspende la cobranza y se requiere revisión humana.", **base)
    if PaymentRepo(conn).pending_for_installment(inst["installment_id"]):
        return Plan(hold="PAYMENT_PENDING", reason="Pago pendiente de verificación: no se contacta hasta confirmarlo.", **base)

    allowed = allowed_channels(customer)
    if not allowed:
        why = "cliente excluido voluntariamente" if customer["opted_out_all"] else "sin canal consentido disponible"
        return Plan(reason=f"Sin acción: {why}.", **base)

    today = _lima(now).date()
    due = date.fromisoformat(inst["due_date"])
    days_to_due = (due - today).days
    constraints: list[str] = []
    promise = next(iter(PromiseRepo(conn).open_for_installment(inst["installment_id"])), None)

    prefer_phone = False
    if promise and date.fromisoformat(promise["promised_date"]) >= today:
        pd = date.fromisoformat(promise["promised_date"])
        action_type = "PROMISE_FOLLOWUP"
        desired = _window_start(pd + timedelta(days=policy.promise_grace_days), policy)
        why = (f"Promesa de pago registrada para el {pd.isoformat()}; no se presiona antes de esa fecha "
               f"(+{policy.promise_grace_days} día de gracia). La promesa NO equivale a pago.")
    elif days_to_due > policy.reminder_lead_days:
        action_type = "PRE_DUE_REMINDER"
        desired = _window_start(due - timedelta(days=policy.reminder_lead_days), policy)
        why = f"Cuota vence en {days_to_due} días; recordatorio {policy.reminder_lead_days} días antes."
    elif days_to_due >= 0:
        action_type = "PRE_DUE_REMINDER"
        desired = None  # inmediato: solo lo limitan las reglas de intervalo/frecuencia/ventana
        why = f"Cuota vence en {days_to_due} día(s) ({inst['due_date']}); recordatorio preventivo."
    elif -days_to_due <= policy.escalate_after_days_overdue:
        action_type = "OVERDUE_FOLLOWUP"
        desired = None
        why = f"Cuota vencida hace {-days_to_due} día(s); seguimiento de cobranza temprana."
        if promise:
            why += " La fecha prometida ya pasó sin pago confirmado."
    else:
        action_type = "ADVISOR_CALL"
        desired = None
        prefer_phone = True
        why = (f"Cuota vencida hace {-days_to_due} días (> {policy.escalate_after_days_overdue}): "
               "escalamiento a contacto con asesor.")

    channel = None
    if hint and hint.get("channel") in allowed:
        channel = hint["channel"]
        constraints.append(f"Canal {channel} tomado de la decisión aprobada {hint['decision_id']}.")
        if hint.get("contact_at"):
            desired = max(desired, hint["contact_at"]) if (promise and desired) else hint["contact_at"]
            constraints.append("Momento tomado de la decisión aprobada.")
    else:
        ranked = _order_channels(allowed, customer, contacts, policy, prefer_phone)
        channel = ranked[0]
        last = contacts.last_outbound(customer_id)
        if last and last["outcome"] in BAD_OUTCOMES and policy.rotate_channel_after_no_response and channel != last["channel"]:
            constraints.append(f"Canal rotado: {last['channel']} terminó en {last['outcome']}.")

    earliest = desired or EPOCH  # piso estable: no depende de "ahora" salvo que una regla lo empuje
    last = contacts.last_outbound(customer_id)
    if last:
        gap = from_iso(last["occurred_at"]) + timedelta(hours=policy.min_hours_between_contacts)
        if gap > earliest:
            if gap > now:
                constraints.append(f"Intervalo mínimo {policy.min_hours_between_contacts}h desde el último contacto "
                                   f"({last['channel']}, {last['outcome']}, {last['occurred_at']}).")
            earliest = gap
    # Límite de frecuencia: máx. N contactos salientes en una ventana móvil de 7 días.
    if policy.max_contacts_per_7d > 0:
        for _ in range(20):
            cand = max(earliest, now)
            recent = [from_iso(c["occurred_at"]) for c in
                      contacts.outbound_since(customer_id, to_iso(cand - timedelta(days=7)))]
            recent = [t for t in recent if t <= cand]
            if len(recent) < policy.max_contacts_per_7d:
                break
            nxt = sorted(recent)[len(recent) - policy.max_contacts_per_7d] + timedelta(days=7)
            constraints.append(f"Límite de frecuencia: máx. {policy.max_contacts_per_7d} contactos/7 días.")
            earliest = max(earliest, nxt)
    earliest = align_to_window(earliest, channel, policy)
    scheduled = align_to_window(max(earliest, now), channel, policy)
    if channel in BUSINESS_DAY_CHANNELS:
        constraints.append("Canal restringido a día hábil.")
    constraints.append(f"Ventana {policy.contact_window_start:02d}:00-{policy.contact_window_end:02d}:00 America/Lima.")
    return Plan(action_type=action_type, channel=channel, earliest=earliest, scheduled_at=scheduled,
                reason=why, decision_id=(hint or {}).get("decision_id"), constraints=constraints, **base)


# -------------------------------------------------------------- reevaluación
def reevaluate_customer(conn: sqlite3.Connection, customer_id: str, now: datetime, trigger: str,
                        event_id: str | None = None, hint: dict | None = None) -> dict:
    """Reconcilia `scheduled_actions` con el estado actual. Debe llamarse dentro de una transacción."""
    started = utcnow()
    customers, actions, insts = CustomerRepo(conn), ActionRepo(conn), InstallmentRepo(conn)
    customer = customers.get(customer_id)
    version = customer["case_version"]
    policy = load_policy(conn)
    plan = plan_next_action(conn, customer_id, now, policy, hint)
    allowed = allowed_channels(customer)

    cancelled, blocked, kept, created = [], [], [], None
    for a in actions.active_for_customer(customer_id):
        inst = insts.get(a["installment_id"]) if a["installment_id"] else None
        if inst and inst["status"] == "PAID":
            actions.set_status(now, a["action_id"], "CANCELLED", "Cuota liquidada: gestión cerrada.")
            cancelled.append(a["action_id"]); continue
        if a["channel"] and a["channel"] not in allowed:
            actions.set_status(now, a["action_id"], "CANCELLED", "Canal no permitido (exclusión voluntaria/consentimiento).")
            cancelled.append(a["action_id"]); continue
        same = (plan.action_type == a["action_type"] and plan.installment_id == a["installment_id"]
                and plan.channel == a["channel"] and plan.earliest is not None
                and plan.earliest <= from_iso(a["scheduled_at"]) <= plan.scheduled_at and plan.hold is None)
        same_hold_action = (plan.hold and plan.action_type == a["action_type"] == "HUMAN_REVIEW")
        if (same or same_hold_action) and created is None and a["status"] != "BLOCKED":
            kw = {"case_version": version}
            if plan.decision_id:
                kw["decision_id"] = plan.decision_id
            actions.set_status(now, a["action_id"], a["status"], "Revalidada contra la versión vigente del expediente.", **kw)
            kept.append(a["action_id"]); created = a["action_id"]; continue
        if plan.hold and a["action_type"] != "HUMAN_REVIEW":
            if a["status"] != "BLOCKED":
                actions.set_status(now, a["action_id"], "BLOCKED", plan.reason)
                blocked.append(a["action_id"])
            continue
        actions.set_status(now, a["action_id"], "CANCELLED", "Reemplazada tras reevaluación del expediente.")
        cancelled.append(a["action_id"])

    new_id_ = None
    if plan.action_type and plan.scheduled_at and not kept:
        row = actions.insert(
            now, customer_id=customer_id, installment_id=plan.installment_id, action_type=plan.action_type,
            channel=plan.channel, scheduled_at=plan.scheduled_at, reason=plan.reason + " " + " ".join(plan.constraints),
            case_version=version, decision_id=plan.decision_id, policy_json=dumps(policy.snapshot()))
        new_id_ = row["action_id"]

    result = {"trigger": trigger, "case_version": version, "plan": plan.public(), "created": new_id_,
              "kept": kept, "cancelled": cancelled, "blocked": blocked}
    AgentRunRepo(conn).insert(
        started, utcnow(), agent_name=AGENT_NAME, customer_id=customer_id, case_version=version, trigger=trigger,
        status="OK", input={"trigger": trigger, "now": to_iso(now), "policy": policy.snapshot()},
        output=result, event_id=event_id)
    return result


def on_decision_approved(conn: sqlite3.Connection, decision: dict, strategy_channel: str | None,
                         contact_at: datetime | None, now: datetime) -> dict:
    hint = {"decision_id": decision["decision_id"], "channel": strategy_channel, "contact_at": contact_at}
    return reevaluate_customer(conn, decision["customer_id"], now, "DECISION_APPROVED", hint=hint)


# ----------------------------------------------------- reloj y ejecución
def tick(conn: sqlite3.Connection, now: datetime) -> dict:
    """Marca DUE las acciones cuyo momento llegó y EXPIRED las que no se ejecutaron a tiempo; reprograma."""
    policy = load_policy(conn)
    due, expired, touched = [], [], set()
    rows = conn.execute("SELECT * FROM scheduled_actions WHERE status IN ('PENDING','DUE') ORDER BY scheduled_at").fetchall()
    actions = ActionRepo(conn)
    for a in rows:
        sched = from_iso(a["scheduled_at"])
        if now > sched + timedelta(hours=policy.action_expiry_hours):
            actions.set_status(now, a["action_id"], "EXPIRED", f"No ejecutada dentro de {policy.action_expiry_hours}h.")
            expired.append(a["action_id"]); touched.add(a["customer_id"])
        elif sched <= now and a["status"] == "PENDING":
            actions.set_status(now, a["action_id"], "DUE", "Llegó el momento programado; pendiente de revalidación y ejecución.")
            due.append(a["action_id"])
    rescheduled = {c: reevaluate_customer(conn, c, now, "ACTION_EXPIRED")["created"] for c in touched}
    return {"now": to_iso(now), "marked_due": due, "expired": expired, "rescheduled": rescheduled}


def execute_action(conn: sqlite3.Connection, action_id: str, now: datetime) -> dict:
    """Ejecución SIMULADA con revalidación previa contra el estado actual. No envía ningún mensaje real."""
    actions, customers = ActionRepo(conn), CustomerRepo(conn)
    a = actions.get(action_id)
    if a is None:
        raise LookupError("Acción no encontrada")
    if a["status"] not in ("PENDING", "DUE"):
        return {"executed": False, "action_id": action_id, "outcome": "NOT_EXECUTABLE",
                "detail": f"Estado actual: {a['status']} ({a['status_reason'] or ''})"}
    if a["action_type"] == "HUMAN_REVIEW":
        return {"executed": False, "action_id": action_id, "outcome": "INTERNAL_ACTION",
                "detail": "Acción interna: requiere revisión humana, no es un contacto."}
    if from_iso(a["scheduled_at"]) > now:
        return {"executed": False, "action_id": action_id, "outcome": "NOT_YET_DUE",
                "detail": f"Programada para {a['scheduled_at']}"}

    version_before = customers.get(a["customer_id"])["case_version"]
    re = reevaluate_customer(conn, a["customer_id"], now, "PRE_EXECUTION_REVALIDATION")
    fresh = actions.get(action_id)
    if fresh["status"] not in ("PENDING", "DUE"):
        return {"executed": False, "action_id": action_id, "outcome": "REVALIDATION_FAILED",
                "detail": fresh["status_reason"], "reevaluation": re}
    if from_iso(fresh["scheduled_at"]) > now:
        return {"executed": False, "action_id": action_id, "outcome": "RESCHEDULED",
                "detail": f"Reglas vigentes lo reprograman a {fresh['scheduled_at']}", "reevaluation": re}

    ContactRepo(conn).insert(
        now, customer_id=a["customer_id"], installment_id=a["installment_id"], channel=a["channel"],
        direction="outbound", outcome="SIMULATED_SENT", occurred_at=now, action_id=action_id,
        decision_id=a["decision_id"], note=f"Ejecución simulada ({a['action_type']}); no se envió ningún mensaje real.")
    actions.set_status(now, action_id, "COMPLETED", "Ejecutada en modo simulado tras revalidación exitosa.")
    nxt = reevaluate_customer(conn, a["customer_id"], now, "POST_EXECUTION")
    return {"executed": True, "action_id": action_id, "outcome": "SIMULATED_SENT", "sent_real_message": False,
            "revalidated_against_case_version": version_before, "next_action_id": nxt["created"]}
