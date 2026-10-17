"""Demo guiada: un caso completo, paso a paso, con evidencia leída de la BD real tras cada paso."""
from __future__ import annotations

import sys
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import streamlit as st

from app import decision_service, scheduling
from app.calendar_pe import LIMA
from app.db import connect, db_path, fmt_money, transaction, utcnow
from app.events import EventIn, EventRejected, process_event
from app.orchestrator import followup_agent, propose_case
from app.repositories import CustomerRepo
from app.seed import create_demo_case, seed_demo
from app.state_views import customer_state, list_customers

st.set_page_config(page_title="NEXO AI · Demo guiada", layout="wide")


def local(iso):
    return datetime.fromisoformat(iso).astimezone(LIMA).strftime("%d/%m/%Y %H:%M") if iso else "—"


st.title("Demo guiada · caso completo")
st.caption("Consola LOCAL de confianza (servicios en proceso, solo localhost). Cada paso escribe en SQLite y muestra lo que quedó guardado. "
           "Sin envíos reales. Los componentes marcados REGLAS son deterministas; ninguno aparece como IA salvo que su traza diga `llm:`.")

with connect() as c:
    customers = [x["customer_id"] for x in list_customers(c)]
side = st.sidebar
side.caption(f"BD: `{db_path()}`")
if not customers and side.button("Cargar clientes demo"):
    with connect() as c:
        seed_demo(c)
    st.rerun()
if side.button("➕ Nuevo caso demo (cuota vencida hace 3 días)"):
    with connect() as c:
        st.session_state["cid"] = create_demo_case(c)
    st.rerun()
if not customers:
    st.info("Base vacía: carga clientes demo o crea un caso nuevo.")
    st.stop()
cid = st.selectbox("Cliente", customers, index=customers.index(st.session_state["cid"]) if st.session_state.get("cid") in customers else 0)
st.session_state["cid"] = cid
G = st.session_state.setdefault("guided", {}).setdefault(cid, {})   # progreso de la demo por cliente


def state():
    with connect() as c:
        return customer_state(c, cid)


def status(n: int) -> str:
    return "✅" if G.get(f"s{n}") else ("▶️" if all(G.get(f"s{k}") for k in range(1, n)) else "⏸️")


def ready(n: int) -> bool:
    return all(G.get(f"s{k}") for k in range(1, n)) and not G.get(f"s{n}")


S0 = state()
inst = S0["customer"]["current_installment"]
cur = S0["loans"][0]["currency"]
c1, c2, c3, c4 = st.columns(4)
c1.metric("Saldo del préstamo", fmt_money(S0["customer"]["outstanding_cents"], cur))
c2.metric("Cuota abierta", fmt_money(inst["amount_cents"] - inst["paid_cents"], cur) if inst else "—", inst["due_date"] if inst else None, delta_color="off")
c3.metric("case_version", S0["customer"]["case_version"])
c4.metric("Estado de la cuota", inst["status"] if inst else "LIQUIDADA")
st.divider()

# ---------------------------------------------------------------- 1. evaluación
st.subheader(f"{status(1)} 1 · Evaluación → estrategia → cumplimiento (orquestador)")
if st.button("Evaluar caso", disabled=not ready(1), key="b1"):
    out = propose_case(cid)
    if out["halted"]:
        st.error(f"Orquestador detenido: {out['reason']}")
    else:
        G["s1"], G["d1"], G["out1"] = True, out["decision_id"], out
        st.rerun()
if G.get("out1"):
    o = G["out1"]
    cols = st.columns(6)
    by = {s["agent"]: s["output"] for s in o["steps"]}
    cols[0].metric("Risk", by["risk_agent"]["band"], f"score {by['risk_agent']['score']:.0f}", delta_color="off")
    cols[1].metric("Strategy", o["proposed"]["strategy"])
    cols[2].metric("Contact", o["proposed"]["channel"])
    cols[3].metric("Conversational", by["conversational_agent"]["engine"])
    cols[4].metric("Negotiation", f"{len(o['proposed']['offers'])} opción(es)")
    cols[5].metric("Compliance", "OK" if o["compliance_status"] == "pending_human_approval" else "BLOQUEADA")
    st.code(by["conversational_agent"]["body"], language="text")
    st.caption(f"Decisión `{o['decision_id']}` · pendiente de aprobación humana · enviado: {o['sent']}")

# ---------------------------------------------------------------- 2. aprobación
st.subheader(f"{status(2)} 2 · Aprobación humana")
reviewer = st.text_input("Revisor", "analista-demo", key="rv")
if st.button("Aprobar como humano", disabled=not ready(2), key="b2"):
    try:
        with connect() as c:
            G["rev"] = decision_service.review_decision(c, G["d1"], reviewer, "approve", "", actor_role="human")
        G["s2"] = True
        st.rerun()
    except decision_service.ReviewConflict as exc:
        st.error(str(exc.detail))
if G.get("s2"):
    S = state()
    act = next((a for a in S["scheduled_actions"] if a["decision_id"] == G["d1"] and a["status"] in ("PENDING", "DUE")), None)
    if act:
        G["act"] = act["action_id"]
        st.success(f"Acción **{act['action_type']}** por **{act['channel']}** programada para **{local(act['scheduled_at'])}** (Lima), "
                   f"vinculada a la decisión aprobada por `{reviewer}`.")
        st.caption(act["reason"])

# ---------------------------------------------------------------- 3. contacto simulado
st.subheader(f"{status(3)} 3 · Contacto simulado (con revalidación previa)")
if st.button("Ejecutar contacto (simulado)", disabled=not ready(3), key="b3"):
    with connect() as c, transaction(c):
        sched = datetime.fromisoformat(next(a for a in S0["scheduled_actions"] if a["action_id"] == G["act"])["scheduled_at"])
        G["exec"] = scheduling.execute_action(c, G["act"], max(sched, utcnow()))
    G["s3"] = bool(G["exec"]["executed"])
    st.rerun()
if G.get("exec"):
    if G["exec"]["executed"]:
        S = state()
        ct = next(x for x in S["contact_history"] if x["action_id"] == G["act"])
        st.success(f"Registrado en contact_history: **{ct['channel']} · {ct['outcome']}** · mensaje real enviado: **{G['exec']['sent_real_message']}**")
    else:
        st.warning(G["exec"])

# ---------------------------------------------------------------- 4. seguimiento
st.subheader(f"{status(4)} 4 · Seguimiento (Follow-up & Learning)")
if st.button("Programar seguimiento", disabled=not ready(4), key="b4"):
    G["fu"] = followup_agent(cid)
    G["s4"] = True
    st.rerun()
if G.get("fu"):
    fu = G["fu"]
    nxt = fu["next_action"]
    st.success(f"Próximo seguimiento: **{nxt['action_type'] if nxt else '—'}** por **{nxt['channel'] if nxt else '—'}** el **{local(fu['next_followup_at'])}** (Lima)")
    st.caption(f"Estadística por canal: {fu['channel_stats']} · mejor canal hasta ahora: {fu['best_channel_so_far']} (regla simple, no un modelo)")

# ---------------------------------------------------------------- 5. pago
st.subheader(f"{status(5)} 5 · Pago confirmado → saldo → invalidación → cierre")
st.caption("Primero se genera otra propuesta pendiente para ver cómo el pago la invalida.")
if st.button("Simular pago completo (simulador bancario)", disabled=not ready(5), key="b5"):
    G["before"] = {"loan": S0["customer"]["outstanding_cents"], "version": S0["customer"]["case_version"]}
    out2 = propose_case(cid)
    G["d2"] = out2.get("decision_id")
    remaining = inst["amount_cents"] - inst["paid_cents"]
    ev = EventIn(event_id=f"dash-{uuid.uuid4().hex[:10]}", event_type="PAYMENT_POSTED", customer_id=cid, source="bank_simulator",
                 installment_id=inst["installment_id"], payload={"payment_ref": f"PAY-{uuid.uuid4().hex[:8]}",
                                                                  "amount_cents": remaining, "currency": cur})
    try:
        with connect() as c:
            G["pay"] = process_event(c, ev)
        G["paid_inst"] = inst["installment_id"]
        G["s5"] = True
    except EventRejected as exc:
        st.error(exc.reason)
    st.rerun()
if G.get("s5"):
    S = state()
    ia = next(i for i in S["installments"] if i["installment_id"] == G["paid_inst"])
    acts = [a for a in S["scheduled_actions"] if a["installment_id"] == G["paid_inst"]]
    d2 = next((d for d in S["decisions"] if d["decision_id"] == G.get("d2")), None)
    a, b = st.columns(2)
    a.metric("Saldo", fmt_money(S["customer"]["outstanding_cents"], cur), f"{fmt_money(S['customer']['outstanding_cents'] - G['before']['loan'], cur)}", delta_color="off")
    b.metric("case_version", S["customer"]["case_version"], f"era {G['before']['version']}", delta_color="off")
    st.success(f"Cuota **{ia['status']}**, cerrada {local(ia['closed_at'])}. Acciones de esa cuota: {', '.join(f'{x['action_type']}={x['status']}' for x in acts)}")
    if d2:
        st.warning(f"Propuesta posterior `{d2['decision_id'][:8]}`: **{d2['validity'].upper()}** — {d2['stale_reason']}")
        try:
            with connect() as c:
                decision_service.review_decision(c, d2["decision_id"], reviewer, "approve", "", actor_role="human")
        except decision_service.ReviewConflict as exc:
            st.error(f"Intentar aprobarla ahora → {exc.status} {exc.detail.get('code')}")
    st.balloons() if not G.get("done") else None
    G["done"] = True
    st.info("Caso completo. Revisa **Mapa de componentes** para ver las trazas reales de cada paso.")
