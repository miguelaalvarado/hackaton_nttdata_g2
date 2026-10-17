"""Capa visual compartida de NEXO AI Demo Arena: tema, lenguaje de negocio y lecturas de SQLite.

Nada aquí cambia la lógica financiera, el scoring ni las reglas de cumplimiento: solo lee estado persistido y
traduce etiquetas técnicas. Todo dato mostrado proviene de SQLite (customers, installments, payments, events, agent_runs...).
"""
from __future__ import annotations

import html
import json
import sys
import uuid
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st

from app import llm
from app.calendar_pe import LIMA
from app.db import connect, db_path, fmt_money, utcnow
from app.events import EventIn, EventRejected, process_event
from app.repositories import AgentRunRepo, PaymentRepo
from app.state_views import customer_state, list_customers

# ---------------------------------------------------------------- lenguaje de negocio
CHANNEL = {"push": "Notificación push", "email": "Correo electrónico", "sms": "SMS", "whatsapp": "WhatsApp",
           "phone_call": "Llamada telefónica", "in_person_visit": "Visita presencial"}
STRATEGY = {"friendly_reminder": "Recordatorio amable", "proactive_support": "Apoyo proactivo", "advisor_outreach": "Contacto con asesor"}
ACTION = {"PRE_DUE_REMINDER": "Recordatorio previo al vencimiento", "OVERDUE_FOLLOWUP": "Seguimiento de cuota vencida",
          "ADVISOR_CALL": "Contacto con asesor", "PROMISE_FOLLOWUP": "Seguimiento del compromiso de pago", "HUMAN_REVIEW": "Revisión humana"}
ACTION_STATUS = {"PENDING": "Programada", "DUE": "Lista para ejecutar", "COMPLETED": "Realizada (simulada)", "CANCELLED": "Cancelada",
                 "BLOCKED": "Suspendida", "EXPIRED": "Vencida sin ejecutar"}
INSTALLMENT = {"OPEN": "Pendiente", "PARTIAL": "Pago parcial", "PAID": "Regularizada"}
PRODUCT = {"credit_card": "Tarjeta de crédito", "personal_loan": "Préstamo personal", "mortgage": "Crédito hipotecario", "auto_loan": "Crédito vehicular"}
EVENT = {"PAYMENT_POSTED": "Pago confirmado por el banco", "PAYMENT_PENDING": "Pago pendiente de verificación",
         "PAYMENT_REVERSED": "Pago revertido", "CUSTOMER_REPLIED": "Respuesta del cliente", "PROMISE_CREATED": "Compromiso de pago",
         "PROMISE_DUE": "Vence el compromiso", "CONTACT_RECORDED": "Contacto registrado", "CONTACT_OPT_OUT": "El cliente pidió no ser contactado",
         "DISPUTE_OPENED": "Disputa abierta", "HUMAN_REVIEW": "Revisión humana", "INVESTIGATE": "Reevaluación solicitada"}
INTENT = {"will_pay": "Dice que pagará", "needs_more_time": "Pide más tiempo", "cannot_pay": "Indica que no puede pagar",
          "disputes_charge": "Disputa el cobro", "asks_information": "Pide información", "wants_to_stop_contact": "Pide no ser contactado",
          "unclear": "No queda claro"}
FIELD = {"behavior.missed_payments_last_6m": "Pagos omitidos (6 meses)", "behavior.on_time_payment_ratio_6m": "Puntualidad histórica (6 meses)",
         "behavior.credit_utilization": "Uso de la línea de crédito", "behavior.payment_trend": "Tendencia de pago", "account.days_past_due": "Días de atraso"}
ROLE_OF = {"risk_agent": "ANALISTA", "strategy_agent": "ANALISTA", "contact_agent": "ANALISTA",
           "conversational_agent": "GESTOR IA", "negotiation_agent": "GESTOR IA",
           "compliance_agent": "SUPERVISOR", "followup_learning": "SUPERVISOR"}
COMPONENT_LABEL = {"risk_agent": "Riesgo", "strategy_agent": "Estrategia", "contact_agent": "Contacto", "conversational_agent": "Conversacional",
                   "negotiation_agent": "Negociación", "compliance_agent": "Cumplimiento", "followup_learning": "Seguimiento"}
COMPONENT_WHAT = {"risk_agent": "Interpreta el riesgo con evidencia verificable", "strategy_agent": "Elige la estrategia preventiva",
                  "contact_agent": "Define canal y horario permitidos", "conversational_agent": "Interpreta al cliente y redacta el mensaje",
                  "negotiation_agent": "Condiciona las opciones de apoyo", "compliance_agent": "Valida contra las reglas de cumplimiento",
                  "followup_learning": "Reprograma el seguimiento tras cada cambio"}
BUCKET = {"ok": ("#166534", "#DCFCE7"), "warn": ("#92400E", "#FEF3C7"), "bad": ("#991B1B", "#FEE2E2"),
          "info": ("#1E40AF", "#DBEAFE"), "ai": ("#065F46", "#CCFBF1"), "muted": ("#475569", "#E2E8F0")}


def esc(x) -> str:
    return html.escape(str(x))


def local(iso: str | None, fmt: str = "%d/%m/%Y %H:%M") -> str:
    return datetime.fromisoformat(iso).astimezone(LIMA).strftime(fmt) if iso else "—"


def money(cents: int, currency: str = "PEN") -> str:
    return fmt_money(cents, currency)


def badge(text: str, kind: str = "muted") -> str:
    fg, bg = BUCKET[kind]
    return f'<span class="nx-badge" style="color:{fg};background:{bg}">{esc(text)}</span>'


def card(title: str, body: str, kind: str | None = None, sub: str | None = None) -> None:
    border = f"border-left:6px solid {BUCKET[kind][0]};" if kind else ""
    st.markdown(f'<div class="nx-card" style="{border}"><div class="nx-card-title">{esc(title)}</div>'
                f'{"<div class=nx-card-sub>" + sub + "</div>" if sub else ""}<div class="nx-card-body">{body}</div></div>',
                unsafe_allow_html=True)


def kpi(label: str, value, hint: str = "", kind: str = "info") -> str:
    fg, bg = BUCKET[kind]
    return (f'<div class="nx-kpi"><div class="nx-kpi-label">{esc(label)}</div><div class="nx-kpi-value" style="color:{fg}">{esc(value)}</div>'
            f'<div class="nx-kpi-hint">{esc(hint)}</div></div>')


CSS = """
<style>
html, body, [class*="css"], .stMarkdown, .stText { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.block-container { padding-top: 1.6rem; max-width: 1280px; }
h1 { font-size: 2.1rem !important; letter-spacing: -0.02em; color:#0B1F44; }
h2, h3 { color:#0B1F44; letter-spacing: -0.01em; }
.nx-hero { background: linear-gradient(135deg,#0B1F44 0%,#1D4ED8 100%); color:#fff; padding: 1.4rem 1.8rem; border-radius: 18px; margin-bottom: 1.1rem; }
.nx-hero h1 { color:#fff !important; margin:0 0 .2rem 0; font-size:2rem !important; }
.nx-hero p { margin:0; opacity:.92; font-size:1.05rem; }
.nx-card { background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:1rem 1.2rem; box-shadow:0 1px 3px rgba(15,23,42,.06); margin-bottom:.8rem; }
.nx-card-title { font-weight:700; font-size:1.05rem; color:#0B1F44; }
.nx-card-sub { color:#64748B; font-size:.9rem; margin-top:.1rem; }
.nx-card-body { margin-top:.5rem; font-size:1rem; line-height:1.5; color:#1E293B; }
.nx-kpi { min-height:138px; background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:1rem 1.2rem; box-shadow:0 1px 3px rgba(15,23,42,.06); height:100%; }
.nx-kpi-label { color:#64748B; font-size:.9rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
.nx-kpi-value { font-size:2.4rem; font-weight:800; line-height:1.15; }
.nx-kpi-hint { color:#64748B; font-size:.85rem; }
.nx-badge { display:inline-block; padding:.18rem .7rem; border-radius:999px; font-size:.82rem; font-weight:700; margin-right:.3rem; white-space:nowrap; }
.nx-person { display:flex; align-items:center; gap:1rem; }
.nx-avatar { width:64px; height:64px; border-radius:50%; background:linear-gradient(135deg,#1D4ED8,#0EA5A4); color:#fff; font-weight:800;
             font-size:1.7rem; display:flex; align-items:center; justify-content:center; flex:none; }
.nx-role { font-weight:800; letter-spacing:.08em; color:#1D4ED8; font-size:.95rem; }
.nx-comp { border:1px solid #E2E8F0; border-radius:12px; padding:.7rem .9rem; margin:.45rem 0; background:#F8FAFC; }
.nx-comp b { color:#0B1F44; }
.nx-small { color:#64748B; font-size:.85rem; }
.stButton > button { height: 3rem; font-size: 1.05rem; font-weight: 700; border-radius: 12px; }
.stButton > button[kind="primary"] { background:#1D4ED8; border-color:#1D4ED8; }
.stButton > button[kind="primary"], .stButton > button[kind="primary"] * { color:#FFFFFF !important; }
.stButton > button[kind="primary"]:hover { background:#1E40AF; border-color:#1E40AF; }
.stButton > button:disabled, .stButton > button[kind="primary"]:disabled { background:#E2E8F0 !important; border-color:#CBD5E1 !important; opacity:1; }
.stButton > button:disabled *, .stButton > button[kind="primary"]:disabled * { color:#94A3B8 !important; }
.stButton > button[kind="secondary"] { background:#fff; color:#0B1F44; border:1.5px solid #94A3B8; }
[data-testid="stSidebar"] { background:#0B1F44; }
[data-testid="stSidebar"] * { color:#E2E8F0; }
[data-testid="stSidebar"] [data-baseweb="select"] > div { background:#fff; }
[data-testid="stSidebar"] [data-baseweb="select"] *, [data-testid="stSidebar"] [data-baseweb="select"] input { color:#0F172A !important; -webkit-text-fill-color:#0F172A !important; opacity:1 !important; }
[data-testid="stSidebar"] .stButton > button { background:#1D4ED8; color:#fff; border:0; }
</style>
"""


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)


def hero(title: str, subtitle: str) -> None:
    st.markdown(f'<div class="nx-hero"><h1>{esc(title)}</h1><p>{esc(subtitle)}</p></div>', unsafe_allow_html=True)


# ---------------------------------------------------------------- lectura de SQLite
def portfolio() -> list[dict]:
    """Resumen por cliente + indicadores derivados (todo desde SQLite)."""
    with connect() as c:
        rows = list_customers(c)
        for r in rows:
            r["pending_payment"] = bool(PaymentRepo(c).pending_for_customer(r["customer_id"]))
            r["paid_installments"] = c.execute("SELECT COUNT(*) FROM installments WHERE customer_id=? AND status='PAID'", (r["customer_id"],)).fetchone()[0]
            r["loan"] = c.execute("SELECT product, currency FROM loans WHERE customer_id=? LIMIT 1", (r["customer_id"],)).fetchone()
    today = utcnow().astimezone(LIMA).date()
    for r in rows:
        inst = r["current_installment"]
        r["days_past_due"] = max((today - date.fromisoformat(inst["due_date"])).days, 0) if inst else 0
        r["days_to_due"] = (date.fromisoformat(inst["due_date"]) - today).days if inst else None
        reasons = []
        if r["days_past_due"] > 0:
            reasons.append(f"cuota vencida hace {r['days_past_due']} día(s)")
        if r["dispute_open"]:
            reasons.append("disputa abierta")
        if r["pending_payment"]:
            reasons.append("pago por verificar")
        if r["needs_reevaluation"]:
            reasons.append("requiere reevaluación")
        r["priority_reasons"] = reasons
        r["priority"] = bool(reasons)
    return rows


def kpis(rows: list[dict]) -> dict:
    return {"clientes": len(rows), "prioritarios": sum(r["priority"] for r in rows),
            "gestiones": sum(1 for r in rows if r["next_action"]), "regularizadas": sum(r["paid_installments"] for r in rows),
            "recomendaciones": sum(r["pending_decisions"] for r in rows)}


def status_badge(r: dict) -> str:
    if r["opted_out_all"]:
        return badge("No contactar", "muted")
    if r["dispute_open"]:
        return badge("En disputa", "bad")
    if r["pending_payment"]:
        return badge("Pago por verificar", "warn")
    if not r["current_installment"]:
        return badge("Al día · todo regularizado", "ok")
    if r["days_past_due"] > 0:
        return badge(f"Vencida hace {r['days_past_due']} d", "bad")
    return badge(f"Vence en {r['days_to_due']} d", "info" if r["days_to_due"] > 5 else "warn")


def state(cid: str) -> dict:
    with connect() as c:
        return customer_state(c, cid)


def runs(cid: str | None = None, limit: int = 400) -> list[dict]:
    with connect() as c:
        rows = AgentRunRepo(c).list(cid, limit)
    for r in rows:
        r["input"], r["output"] = json.loads(r.pop("input_json")), json.loads(r.pop("output_json"))
    return rows


def engine_kind(output: dict) -> str:
    """'ai' solo si la traza lo respalda; 'fallback' si OpenAI falló; en otro caso 'rules'."""
    if output.get("fallback"):
        return "fallback"
    if str(output.get("engine", "rules")).startswith("llm:"):
        return "ai"
    return "rules"


def engine_badge(output: dict) -> str:
    k = engine_kind(output)
    if k == "ai":
        prov = output.get("provider", "llm")
        return badge(f"IA REAL · {prov.capitalize()}", "ai")
    if k == "fallback":
        return badge("FALLBACK A REGLAS", "warn")
    return badge("REGLAS", "info")


def latest_by_agent(rs: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in rs:  # ya vienen de más reciente a más antigua
        out.setdefault(r["agent_name"], r)
    return out


def send_event(cid: str, event_type: str, source: str, installment_id: str | None = None, **payload) -> tuple[bool, dict | str]:
    """Registra un evento REAL en SQLite (mismo motor que la API). Devuelve (ok, resultado|motivo)."""
    ev = EventIn(event_id=f"arena-{uuid.uuid4().hex[:10]}", event_type=event_type, customer_id=cid, source=source,
                 installment_id=installment_id, occurred_at=utcnow(), payload=payload)
    try:
        with connect() as c:
            return True, process_event(c, ev)
    except EventRejected as rej:
        return False, rej.reason


def explain_changes(res: dict) -> list[str]:
    """Traduce la traza real de un evento a frases de negocio."""
    out = []
    for ch in res["trace"].get("changes", []):
        w = ch["what"]
        if w == "payment_recorded":
            out.append(f"Pago registrado: {ch.get('amount')}")
        elif w == "balances_updated":
            out.append(f"Saldo del préstamo actualizado; cuota {INSTALLMENT.get(ch.get('installment_status'), ch.get('installment_status'))}")
        elif w == "installment_closed":
            out.append("Cuota regularizada y gestión cerrada")
        elif w == "decisions_invalidated":
            out.append(f"{len(ch['decision_ids'])} recomendación(es) pendiente(s) quedaron OBSOLETAS")
        elif w == "case_version":
            out.append(f"Nueva versión del expediente ({ch['new']}): {ch['reason']}")
        elif w == "promise_recorded":
            out.append(f"Compromiso registrado ({ch['amount']} para {ch['promised_date']}); no se trata como pago")
        elif w == "dispute_opened":
            out.append("Disputa abierta: se suspende la cobranza hasta revisión humana")
        elif w == "conversation_message_recorded":
            out.append("Mensaje del cliente guardado en la conversación")
        elif w == "duplicate_payment_ignored":
            out.append("Pago duplicado ignorado (no se contó dos veces)")
        elif w == "pending_payment_recorded":
            out.append("Pago pendiente registrado sin descontar saldo")
    re = res["trace"].get("reevaluation")
    if re:
        if re.get("cancelled"):
            out.append(f"{len(re['cancelled'])} gestión(es) programada(s) cancelada(s)")
        if re.get("blocked"):
            out.append(f"{len(re['blocked'])} gestión(es) suspendida(s)")
        if re.get("created"):
            out.append("Se programó una nueva gestión")
    return out


def sidebar(select: bool = True) -> str | None:
    """Barra lateral común: estado de IA, base de datos y selector de cliente."""
    inject_css()
    sb = st.sidebar
    sb.markdown("### NEXO AI")
    sb.caption("Demo Arena · Cobranza temprana · datos ficticios")
    ai = llm.status()
    if ai["active"] == "openai":
        sb.success(f"IA generativa configurada: OpenAI · {ai['model'] or 'falta OPENAI_MODEL'}")
    elif ai["active"] == "anthropic":
        sb.success(f"IA generativa configurada: Anthropic · {ai['model']}")
    else:
        sb.warning("IA generativa NO configurada: los componentes corren con reglas.")
    sb.caption("Configurada ≠ usada: la evidencia de IA real se muestra solo si existe una traza en agent_runs.")
    cid = None
    if select:
        rows = portfolio()
        if not rows:
            sb.info("Base vacía. Ve a *Portafolio* y carga clientes demo.")
        else:
            ids = [r["customer_id"] for r in rows]
            names = {r["customer_id"]: f"{r['first_name']} · {PRODUCT.get(r['loan']['product'], '') if r['loan'] else ''}" for r in rows}
            dup = {n for n in names.values() if list(names.values()).count(n) > 1}
            labels = {i: (n if n not in dup else f"{n} ({i[-4:]})") for i, n in names.items()}
            cur = st.session_state.get("cid")
            cid = st.selectbox("Cliente", ids, index=ids.index(cur) if cur in ids else 0, format_func=lambda i: labels[i], key="cid-select")
            st.session_state["cid"] = cid
    sb.caption(f"BD: {Path(db_path()).name}")
    return cid


# ------------------------------------------------------------- componentes compartidos
def run_analysis(cid: str) -> dict:
    """Ejecuta el orquestador real (Riesgo→Estrategia→Contacto→Conversacional→Negociación→Cumplimiento)."""
    from app.orchestrator import propose_case
    out = propose_case(cid)
    st.session_state.setdefault("last_run", {})[cid] = out
    return out


def customer_header(S: dict) -> None:
    c = S["customer"]
    inst = c["current_installment"]
    loan = S["loans"][0] if S["loans"] else None
    cur = loan["currency"] if loan else "PEN"
    paid = [p for p in S["payments"] if p["kind"] == "PAYMENT" and p["status"] == "CONFIRMED"]
    today = utcnow().astimezone(LIMA).date()
    if inst:
        d = (date.fromisoformat(inst["due_date"]) - today).days
        when = f"vence en {d} día(s)" if d >= 0 else f"vencida hace {-d} día(s)"
        due_badge = badge(when.capitalize(), "info" if d > 5 else ("warn" if d >= 0 else "bad"))
    else:
        due_badge = badge("Todas las cuotas regularizadas", "ok")
    flags = ""
    if c["dispute_open"]:
        flags += badge("En disputa", "bad")
    if c["opted_out_all"]:
        flags += badge("No contactar", "muted")
    if S["payments"] and any(p["status"] == "PENDING" for p in S["payments"]):
        flags += badge("Pago por verificar", "warn")
    st.markdown(
        f'<div class="nx-card"><div class="nx-person"><div class="nx-avatar">{esc(c["first_name"][:1].upper())}</div><div>'
        f'<div style="font-size:1.6rem;font-weight:800;color:#0B1F44">{esc(c["first_name"])} <span class="nx-small">cliente sintético</span></div>'
        f'<div class="nx-small">{esc(PRODUCT.get(loan["product"], loan["product"]) if loan else "—")} · idioma {esc(c["language"].upper())}</div>'
        f'<div style="margin-top:.4rem">{due_badge}{flags}</div></div></div></div>', unsafe_allow_html=True)
    cols = st.columns(5)
    items = [("Cuota", money(inst["amount_cents"], cur) if inst else "—", f"Vence {inst['due_date']}" if inst else "Sin cuota abierta"),
             ("Pendiente de la cuota", money(inst["amount_cents"] - inst["paid_cents"], cur) if inst else money(0, cur),
              INSTALLMENT.get(inst["status"], "") if inst else "Regularizada"),
             ("Pagos confirmados", str(len(paid)), money(sum(p["amount_cents"] for p in paid), cur) + " en total"),
             ("Saldo del préstamo", money(c["outstanding_cents"], cur), "Fuente: base de datos"),
             ("Próxima acción", ACTION.get(c["next_action"]["action_type"], "—") if c["next_action"] else "Sin acción programada",
              local(c["next_action"]["scheduled_at"]) if c["next_action"] else "")]
    for col, (a, b, h) in zip(cols, items):
        small = len(b) > 14
        col.markdown(f'<div class="nx-kpi"><div class="nx-kpi-label">{esc(a)}</div><div class="nx-kpi-value" style="font-size:{"1.15rem" if small else "1.7rem"};'
                     f'color:#0B1F44">{esc(b)}</div><div class="nx-kpi-hint">{esc(h)}</div></div>', unsafe_allow_html=True)


def signals(S: dict) -> list[str]:
    """Señales verificables: cada una sale de un dato persistido."""
    c, out = S["customer"], []
    inst = c["current_installment"]
    if inst:
        d = (utcnow().astimezone(LIMA).date() - date.fromisoformat(inst["due_date"])).days
        out.append(f"Cuota {'vencida hace ' + str(d) + ' día(s)' if d > 0 else 'al día' if d <= 0 else ''} (vencimiento {inst['due_date']})")
    broken = [p for p in S["promises"] if p["status"] == "BROKEN"]
    if broken:
        out.append(f"{len(broken)} compromiso(s) de pago incumplido(s)")
    kept = [p for p in S["promises"] if p["status"] == "KEPT"]
    if kept:
        out.append(f"{len(kept)} compromiso(s) de pago cumplido(s)")
    outs = [x for x in S["contact_history"] if x["direction"] == "outbound"]
    if outs:
        out.append(f"Último contacto: {CHANNEL.get(outs[0]['channel'], outs[0]['channel'])} el {local(outs[0]['occurred_at'])}")
    if any(x["direction"] == "inbound" for x in S["contact_history"]):
        out.append("El cliente respondió a la gestión")
    if c["dispute_open"]:
        out.append("Hay una disputa abierta")
    if S["payments"] and any(p["status"] == "PENDING" for p in S["payments"]):
        out.append("Hay un pago pendiente de verificación")
    paid = [p for p in S["payments"] if p["kind"] == "PAYMENT" and p["status"] == "CONFIRMED"]
    out.append(f"{len(paid)} pago(s) confirmado(s) por el banco" if paid else "Aún sin pagos confirmados")
    return out


def openai_panel(run: dict | None) -> None:
    """Evidencia de IA real: SOLO desde una traza de agent_runs (conversational_agent)."""
    st.markdown("#### Evidencia de IA generativa")
    if run is None:
        st.info("Todavía no hay una ejecución del Gestor IA para este cliente. Ejecuta el análisis para generar trazas.")
        return
    o = run["output"]
    kind = engine_kind(o)
    when = local(run["started_at"], "%d/%m/%Y %H:%M:%S")
    if kind == "ai":
        u = o.get("usage", {})
        tools = o.get("tool_log", [])
        st.markdown(
            f'<div class="nx-card" style="border-left:6px solid #065F46"><div class="nx-card-title">{badge("IA REAL · OpenAI", "ai")} verificada en agent_runs</div>'
            f'<div class="nx-card-body"><b>Modelo:</b> {esc(o.get("model"))} &nbsp;·&nbsp; <b>Tiempo:</b> {o.get("duration_ms", 0) / 1000:.2f} s &nbsp;·&nbsp; '
            f'<b>Tokens:</b> {u.get("input_tokens", 0)} entrada / {u.get("output_tokens", 0)} salida &nbsp;·&nbsp; <b>Rondas:</b> {o.get("rounds", "—")}<br>'
            f'<b>Herramientas de solo lectura efectivamente llamadas:</b> '
            f'{" ".join(badge(t["tool"], "info") for t in tools if "error" not in t) or "—"}'
            f'{"<br><b>Intentos rechazados:</b> " + " ".join(badge(t["tool"] + ": " + t["error"], "bad") for t in tools if "error" in t) if any("error" in t for t in tools) else ""}'
            f'<br><b>Cómo interpretó al cliente:</b> {esc(INTENT.get(o.get("customer_intent"), o.get("customer_intent")))} '
            f'(confianza {esc(o.get("intent_confidence"))}) — {esc(o.get("interpretation"))}</div>'
            f'<div class="nx-small">Traza {esc(run["run_id"])} · {when} · el modelo solo propone: no registra pagos, no aprueba y no elige canal.</div></div>',
            unsafe_allow_html=True)
    elif kind == "fallback":
        fb = o["fallback"]
        st.markdown(
            f'<div class="nx-card" style="border-left:6px solid #92400E"><div class="nx-card-title">{badge("FALLBACK A REGLAS", "warn")} OpenAI no se usó en esta ejecución</div>'
            f'<div class="nx-card-body"><b>Se intentó:</b> {esc(fb["from"])}<br><b>Motivo:</b> {esc(fb["reason"])}<br>'
            f'El mensaje se redactó con plantillas deterministas y siguió el flujo normal de cumplimiento y aprobación humana.</div>'
            f'<div class="nx-small">Traza {esc(run["run_id"])} · {when}</div></div>', unsafe_allow_html=True)
    else:
        ai = llm.status()
        why = "no hay proveedor de IA configurado" if not ai["active"] else "el proveedor estaba configurado pero esta corrida fue anterior o usó plantillas"
        st.markdown(
            f'<div class="nx-card" style="border-left:6px solid #1E40AF"><div class="nx-card-title">{badge("REGLAS", "info")} Esta ejecución NO usó IA generativa</div>'
            f'<div class="nx-card-body">Redacción por plantillas deterministas ({esc(why)}).</div>'
            f'<div class="nx-small">Traza {esc(run["run_id"])} · {when}</div></div>', unsafe_allow_html=True)


def friendly_conflict(detail) -> str:
    code = detail.get("code") if isinstance(detail, dict) else None
    return {"STALE_CASE_VERSION": "Esta recomendación quedó OBSOLETA porque el expediente cambió después de generarla. Hay que reevaluar el caso.",
            "DISPUTE_OPEN": "Hay una disputa abierta: la cobranza está suspendida hasta la revisión humana de la disputa.",
            "PAYMENT_PENDING": "Hay un pago pendiente de verificación: no se aprueban recomendaciones hasta confirmarlo."}.get(
        code, detail.get("message") if isinstance(detail, dict) else str(detail))
