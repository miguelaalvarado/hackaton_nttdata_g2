"""Dashboard local NEXO AI. Todo lo que muestra y todos los botones operan sobre la base SQLite real."""
from __future__ import annotations

import json
import sys
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
import streamlit as st

from app import decision_service, demo_agent, scheduling
from app.calendar_pe import LIMA
from app.db import connect, db_path, fmt_money, transaction, utcnow
from app.events import EventIn, EventRejected, process_event
from app.main import evaluate_agent_proposal
from app.repositories import CustomerRepo
from app.seed import seed_demo
from app.state_views import customer_state, list_customers

st.set_page_config(page_title="NEXO AI · Cobranza temprana", layout="wide")


def local(iso: str | None) -> str:
    return datetime.fromisoformat(iso).astimezone(LIMA).strftime("%d/%m/%Y %H:%M") if iso else "—"


def money(cents, cur="PEN"):
    return fmt_money(cents, cur)


# ----------------------------------------------------------- barra lateral
st.sidebar.title("NEXO AI")
st.sidebar.caption(f"BD: `{db_path()}`")
offset = st.sidebar.number_input("Reloj de demo: adelantar días", 0, 120, 0, help="Mueve 'ahora' para ver vencimientos, DUE y EXPIRED.")
NOW = utcnow() + timedelta(days=int(offset))
st.sidebar.write(f"Ahora (Lima): **{NOW.astimezone(LIMA):%d/%m/%Y %H:%M}**")
if st.sidebar.button("Cargar clientes demo (idempotente)"):
    with connect() as c:
        st.sidebar.success(str(seed_demo(c, NOW)))
if st.sidebar.button("⏱ Tick del scheduler (marcar DUE / EXPIRED)"):
    with connect() as c, transaction(c):
        st.sidebar.json(scheduling.tick(c, NOW))
st.sidebar.divider()
with connect() as c:
    customers = list_customers(c)
    pol = scheduling.load_policy(c)
with st.sidebar.expander("Política de seguimiento (configurable, auditada)"):
    new = {}
    for k, v in pol.snapshot().items():
        if isinstance(v, bool):
            new[k] = st.checkbox(k, v, key=f"pol_{k}")
        else:
            new[k] = int(st.number_input(k, 0, 1000, v, key=f"pol_{k}"))
    st.caption("Supuestos de trabajo, no reglas legales. Cada acción guarda el snapshot aplicado.")
    if st.button("Guardar política") and new != pol.snapshot():
        with connect() as c, transaction(c):
            scheduling.save_policy(c, utcnow(), {k: v for k, v in new.items() if v != pol.snapshot()[k]}, "dashboard")
        st.rerun()

st.title("NEXO AI · Cobranza temprana")
st.caption("Datos 100% ficticios · Sin envíos reales · Todo se persiste en SQLite · Consola LOCAL de confianza (no exponer a la red)")

if not customers:
    st.info("La base está vacía. Usa **Cargar clientes demo** en la barra lateral.")
    st.stop()

# ------------------------------------------------------------ lista clientes
df = pd.DataFrame([{
    "Cliente": c["customer_id"], "Nombre": c["first_name"], "Saldo": money(c["outstanding_cents"], c["currency"] or "PEN"),
    "Cuota abierta": c["current_installment"]["due_date"] if c["current_installment"] else "—",
    "Estado cuota": c["current_installment"]["status"] if c["current_installment"] else "—",
    "Próxima acción": (f"{c['next_action']['action_type']} · {c['next_action']['channel'] or 'interno'} · {local(c['next_action']['scheduled_at'])}"
                       if c["next_action"] else "—"),
    "Versión": c["case_version"], "Re-evaluar": "⚠️" if c["needs_reevaluation"] else "",
    "Disputa": "⛔" if c["dispute_open"] else "", "Excluido": "🚫" if c["opted_out_all"] else "",
    "Recs. pendientes": c["pending_decisions"],
} for c in customers])
st.subheader("Clientes")
st.dataframe(df, hide_index=True, width="stretch")

cid = st.selectbox("Cliente", [c["customer_id"] for c in customers],
                   format_func=lambda i: f"{i} · {next(c['first_name'] for c in customers if c['customer_id'] == i)}")
with connect() as c:
    S = customer_state(c, cid)
cust, insts = S["customer"], S["installments"]
cur = S["loans"][0]["currency"] if S["loans"] else "PEN"
open_inst = cust["current_installment"]

# -------------------------------------------------------------- simulación
def send(event_type: str, source: str = "system", installment_id: str | None = None, **payload):
    ev = EventIn(event_id=f"dash-{uuid.uuid4().hex[:10]}", event_type=event_type, customer_id=cid, source=source,
                 installment_id=installment_id, occurred_at=NOW, payload=payload)
    try:
        with connect() as c:
            res = process_event(c, ev)
        st.session_state["last"] = ("ok", res)
    except EventRejected as rej:
        st.session_state["last"] = ("err", rej.reason)
    st.rerun()


st.subheader(f"Simular eventos · {cid}")
b = st.columns(7)
remaining = (open_inst["amount_cents"] - open_inst["paid_cents"]) if open_inst else 0
if open_inst:
    iid = open_inst["installment_id"]
    if b[0].button("💳 Pago completo", disabled=remaining == 0):
        send("PAYMENT_POSTED", "bank_simulator", iid, payment_ref=f"PAY-{uuid.uuid4().hex[:8]}", amount_cents=remaining, currency=cur)
    pct = b[1].number_input("% parcial", 5, 95, 40, step=5, label_visibility="collapsed")
    if b[1].button("💳 Pago parcial"):
        send("PAYMENT_POSTED", "bank_simulator", iid, payment_ref=f"PAY-{uuid.uuid4().hex[:8]}", amount_cents=max(1, remaining * pct // 100), currency=cur)
    if b[2].button("⏳ Pago pendiente"):
        send("PAYMENT_PENDING", "bank_simulator", iid, payment_ref=f"PAY-{uuid.uuid4().hex[:8]}", amount_cents=remaining, currency=cur)
    reply = b[3].text_input("Respuesta", "No puedo pagar hasta fin de mes", label_visibility="collapsed")
    if b[3].button("💬 Respuesta cliente"):
        send("CUSTOMER_REPLIED", "customer_channel", text=reply, channel=(cust["next_action"] or {}).get("channel") or "whatsapp")
    pdate = b[4].date_input("Fecha prometida", date.today() + timedelta(days=5), label_visibility="collapsed")
    if b[4].button("🤝 Compromiso de pago"):
        send("PROMISE_CREATED", installment_id=iid, amount_cents=remaining, promised_date=pdate.isoformat())
    if b[5].button("⚖️ Disputa"):
        send("DISPUTE_OPENED", reason="Cliente no reconoce el cargo (demo)")
    optch = b[6].selectbox("Canal", ["TODOS"] + cust["consent_channels"], label_visibility="collapsed")
    if b[6].button("🚫 Exclusión voluntaria"):
        send("CONTACT_OPT_OUT", "customer_channel", **({"all": True} if optch == "TODOS" else {"channels": [optch]}))
else:
    st.success("Todas las cuotas de este cliente están liquidadas.")

e = st.columns(5)
pend = [p for p in S["payments"] if p["status"] == "PENDING"]
if pend and e[0].button("✅ Confirmar pago pendiente (banco)"):
    p = pend[0]
    send("PAYMENT_POSTED", "bank_simulator", p["installment_id"], payment_ref=p["payment_ref"], amount_cents=p["amount_cents"], currency=p["currency"])
conf = [p for p in S["payments"] if p["status"] == "CONFIRMED" and p["kind"] == "PAYMENT"]
if conf and e[1].button("↩️ Revertir último pago"):
    send("PAYMENT_REVERSED", "bank_simulator", conf[-1]["installment_id"], payment_ref=conf[-1]["payment_ref"])
if cust["dispute_open"] and e[2].button("🧑‍⚖️ Resolver disputa (humano)"):
    send("HUMAN_REVIEW", "human", kind="resolve_dispute", reviewer_id="analista-demo")
openp = [p for p in S["promises"] if p["status"] == "OPEN"]
if openp and e[3].button("📅 PROMISE_DUE (vence promesa)"):
    send("PROMISE_DUE", promise_id=openp[0]["promise_id"])
if e[4].button("🔎 INVESTIGATE"):
    send("INVESTIGATE", reason="Solicitud manual desde dashboard")

if "last" in st.session_state:
    kind, res = st.session_state["last"]
    (st.success if kind == "ok" else st.error)(
        f"Evento {res['event_type']} → {res['status']}" + (" (replay idempotente)" if res.get("idempotent_replay") else "") if kind == "ok" else f"Rechazado: {res}")
    if kind == "ok":
        with st.expander("Traza del último evento"):
            st.json(res["trace"])

# ------------------------------------------------------------------ detalle
m = st.columns(5)
m[0].metric("Saldo", money(cust["outstanding_cents"], cur))
m[1].metric("Cuota abierta", money(remaining, cur) if open_inst else "—", delta=f"vence {open_inst['due_date']}" if open_inst else None, delta_color="off")
m[2].metric("case_version", cust["case_version"])
m[3].metric("Requiere reevaluación", "Sí" if cust["needs_reevaluation"] else "No", help=cust["reevaluation_reason"])
m[4].metric("Estado", "Disputa" if cust["dispute_open"] else ("Excluido" if cust["opted_out_all"] else "Activo"))

na = cust["next_action"]
st.subheader("Próxima acción programada")
if na:
    c1, c2 = st.columns([3, 1])
    c1.info(f"**{na['action_type']}** por **{na['channel'] or 'revisión interna'}** el **{local(na['scheduled_at'])}** (Lima) · "
            f"estado **{na['status']}** · agente responsable: `{na['responsible_agent']}` · case_version {na['case_version']}"
            f"{' · decisión ' + na['decision_id'] if na['decision_id'] else ''}\n\n**Justificación:** {na['reason']}")
    if c2.button("▶ Ejecutar (simulado, con revalidación)"):
        with connect() as c, transaction(c):
            out = scheduling.execute_action(c, na["action_id"], NOW)
        st.session_state["exec"] = out
        st.rerun()
else:
    st.warning(f"Sin acción pendiente. {' | '.join(a['status_reason'] or '' for a in cust['blocked_actions']) or ''}")
for a in cust["blocked_actions"]:
    st.error(f"Acción BLOCKED {a['action_type']}: {a['status_reason']}")
if "exec" in st.session_state:
    st.json(st.session_state.pop("exec"))

st.subheader("Recomendaciones de agentes (aprobación humana)")
if st.button("🤖 Pedir propuesta al agente demo → /v1/agent-proposals/evaluate"):
    try:
        with connect() as c:
            req = demo_agent.build_proposal(c, cid, NOW)
        evaluate_agent_proposal(req)
        st.rerun()
    except ValueError as exc:
        st.error(str(exc))
if st.button("🧭 Ejecutar orquestador (Risk→Strategy→Contact→Conversational→Negotiation→Compliance)"):
    from app.orchestrator import propose_case
    st.session_state["orch"] = propose_case(cid, NOW)
    st.rerun()
if "orch" in st.session_state:
    o = st.session_state.pop("orch")
    (st.warning if o["halted"] else st.success)(o.get("reason") or f"Decisión {o['decision_id'][:8]} · {o['compliance_status']} · pendiente de aprobación humana")
    with st.expander("Pasos del orquestador"):
        st.json(o["steps"])
for d in S["decisions"][:8]:
    s = d["summary"]
    tag = {"pending": "🟡 pendiente", "approved": "🟢 aprobada", "rejected": "⚪ rechazada"}[d["review_status"]]
    stale = " · 🔴 OBSOLETA" if d["validity"] == "stale" else ""
    with st.expander(f"{tag}{stale} · {d['decision_id'][:8]} · {d['source']} · v{d['case_version']} · cumplimiento: {d['compliance_status']}", expanded=d["review_status"] == "pending" and d["validity"] == "valid"):
        st.write(f"**Estrategia:** {s['strategy']['code']} · canal {s['message']['channel']} · agente `{d['agent_id'] or 'motor de reglas'}`")
        st.write(s["message"]["body"])
        if d["stale_reason"]:
            st.error(f"Obsoleta: {d['stale_reason']}. Debe reevaluarse.")
        for n in s["alignment_notes"]:
            st.warning(n)
        for v in s["compliance"]["violations"]:
            st.error(v)
        if d["review_status"] == "pending":
            r1, r2, _ = st.columns([1, 1, 4])
            if r1.button("Aprobar", key=f"ap{d['decision_id']}"):
                try:
                    with connect() as c:
                        out = decision_service.review_decision(c, d["decision_id"], "revisor-demo", "approve", "", actor_role="human")
                    st.success(str(out))
                except decision_service.ReviewConflict as exc:
                    st.error(json.dumps(exc.detail, ensure_ascii=False))
            if r2.button("Rechazar", key=f"rj{d['decision_id']}"):
                with connect() as c:
                    decision_service.review_decision(c, d["decision_id"], "revisor-demo", "reject", "", actor_role="human")
                st.rerun()

tabs = st.tabs(["Cuotas", "Pagos", "Contactos", "Conversación", "Promesas", "Agenda completa", "Timeline de eventos", "Trazas de agentes"])
with tabs[0]:
    st.dataframe(pd.DataFrame([{"Cuota": i["sequence"], "Vence": i["due_date"], "Monto": money(i["amount_cents"], cur),
                                "Pagado": money(i["paid_cents"], cur), "Pendiente": money(i["amount_cents"] - i["paid_cents"], cur),
                                "Estado": i["status"], "Cerrada": local(i["closed_at"])} for i in insts]), hide_index=True, width="stretch")
with tabs[1]:
    st.dataframe(pd.DataFrame([{"Fecha": local(p["posted_at"]), "Ref": p["payment_ref"], "Tipo": p["kind"], "Monto": money(p["amount_cents"], p["currency"]),
                                "Estado": p["status"], "Evento": p["source_event_id"]} for p in S["payments"]]), hide_index=True, width="stretch")
with tabs[2]:
    st.dataframe(pd.DataFrame([{"Fecha": local(x["occurred_at"]), "Canal": x["channel"], "Dir.": x["direction"], "Resultado": x["outcome"], "Nota": x["note"]} for x in S["contact_history"]]), hide_index=True, width="stretch")
with tabs[3]:
    for m_ in S["conversations"]:
        st.chat_message("user" if m_["sender"] == "customer" else "assistant").write(f"[{m_['channel']}] {m_['text']}")
with tabs[4]:
    st.dataframe(pd.DataFrame([{"Fecha prometida": p["promised_date"], "Monto": money(p["promised_amount_cents"], cur), "Estado": p["status"]} for p in S["promises"]]), hide_index=True, width="stretch")
with tabs[5]:
    st.dataframe(pd.DataFrame([{"Programada": local(a["scheduled_at"]), "Tipo": a["action_type"], "Canal": a["channel"], "Estado": a["status"],
                                "Motivo de estado": a["status_reason"], "v": a["case_version"], "Agente": a["responsible_agent"], "Razón": a["reason"]} for a in S["scheduled_actions"]]), hide_index=True, width="stretch")
with tabs[6]:
    for ev_ in reversed(S["events"]):
        icon = {"PROCESSED": "🟢", "DUPLICATE": "🟠", "REJECTED": "🔴"}[ev_["status"]]
        with st.expander(f"{icon} {local(ev_['received_at'])} · {ev_['event_type']} · {ev_['status']} · v→{ev_['case_version_after']} · {ev_['event_id']}"):
            st.json({"source": ev_["source"], "payload": ev_["payload"], "reason": ev_["reason"], "trace": ev_["trace"]})
with tabs[7]:
    for r in S["agent_runs"]:
        with st.expander(f"{local(r['started_at'])} · {r['agent_name']} · {r['trigger']} · v{r['case_version']} · {r['status']}"):
            st.json({"input": r["input"], "output": r["output"], "decision_id": r["decision_id"], "event_id": r["event_id"]})
