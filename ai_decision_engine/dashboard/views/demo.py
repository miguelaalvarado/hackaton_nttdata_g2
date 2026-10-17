"""Demo en 2 minutos: caso de María de principio a fin. Cada paso opera sobre SQLite y muestra su evidencia."""
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import streamlit as st

from dashboard import ui
from app import decision_service
from app.db import connect
from app.seed import create_demo_case

ui.sidebar(select=False)
ui.hero("Demo en 2 minutos · El caso de María", "De la alerta temprana al pago confirmado: agentes que proponen, personas que aprueban, datos que se actualizan.")

with connect() as c:
    marias = [r[0] for r in c.execute("SELECT customer_id FROM customers WHERE first_name='María' ORDER BY created_at DESC")]
G_all = st.session_state.setdefault("demo", {})

if not marias:
    ui.card("Falta el caso de María", "Para la demo se crea un cliente sintético NUEVO. No se modifica ni borra nada existente.", "info")
    ok = st.checkbox("Confirmo crear el caso sintético de María")
    if st.button("Crear caso de María", type="primary", disabled=not ok):
        with connect() as c:
            create_demo_case(c, first_name="María")
        st.rerun()
    st.stop()

cid = marias[0]
G = G_all.setdefault(cid, {})
st.session_state["cid"] = cid
with st.sidebar:
    st.caption("Caso de la demo")
    with st.expander("Empezar de nuevo con otro caso de María"):
        ok2 = st.checkbox("Confirmo agregar OTRO caso sintético", key="again")
        if st.button("Crear nuevo caso", disabled=not ok2):
            with connect() as c:
                create_demo_case(c, first_name="María")
            st.rerun()

_S0 = ui.state(cid)
if (_S0["events"] or _S0["decisions"]) and not G.get("s1"):
    ui.card("Este caso de María ya se usó", "Ya tiene eventos y decisiones guardadas. Para recorrer la demo desde cero se crea un caso sintético NUEVO "
            "(los datos anteriores se conservan intactos).", "warn")
    okn = st.checkbox("Confirmo crear un caso nuevo de María", key="newcase")
    if st.button("Crear caso nuevo de María", type="primary", disabled=not okn):
        with connect() as c:
            create_demo_case(c, first_name="María")
        st.rerun()
    st.stop()

STEPS = ["Abrir expediente", "Análisis y propuesta", "Control del supervisor", "Revisar recomendación", "Respuesta del cliente + IA", "Pago confirmado", "Nuevo saldo y cancelaciones"]
done = sum(bool(G.get(f"s{i}")) for i in range(1, 8))
st.progress(done / 7, text=f"Paso {min(done + 1, 7)} de 7 · {STEPS[min(done, 6)]}")


def ready(n: int) -> bool:
    return all(G.get(f"s{k}") for k in range(1, n)) and not G.get(f"s{n}")


def head(n: int, text: str) -> None:
    mark = "✅" if G.get(f"s{n}") else ("▶️" if ready(n) else "⏳")
    st.markdown(f"### {mark} {n}. {text}")


S = ui.state(cid)
inst = S["customer"]["current_installment"]
cur = S["loans"][0]["currency"]

# 1 -------------------------------------------------------------------------
head(1, "Abrir el expediente de María")
if st.button("Abrir expediente", type="primary", disabled=not ready(1), key="d1"):
    G["s1"] = True
    G["before"] = {"loan": S["customer"]["outstanding_cents"], "pending": inst["amount_cents"] - inst["paid_cents"]}
    st.rerun()
if G.get("s1"):
    ui.customer_header(S)

# 2 -------------------------------------------------------------------------
head(2, "Ejecutar análisis y propuesta")
if st.button("Ejecutar análisis", type="primary", disabled=not ready(2), key="d2"):
    out = ui.run_analysis(cid)
    if out["halted"]:
        st.error(out["reason"])
    else:
        G["s2"], G["d1"] = True, out["decision_id"]
        st.rerun()
if G.get("s2"):
    rs = ui.latest_by_agent([r for r in ui.runs(cid) if r["trigger"].startswith("orchestrator:")][:12])
    cols = st.columns(3)
    for col, (role, names) in zip(cols, [("ANALISTA", ["risk_agent", "strategy_agent", "contact_agent"]), ("GESTOR IA", ["conversational_agent", "negotiation_agent"]),
                                          ("SUPERVISOR", ["compliance_agent"])]):
        col.markdown(f'<div class="nx-role">{role}</div>' + "".join(f'<div class="nx-comp"><b>{ui.COMPONENT_LABEL[n]}</b> {ui.engine_badge(rs[n]["output"]) if n in rs else ""}</div>' for n in names),
                     unsafe_allow_html=True)

# 3 -------------------------------------------------------------------------
head(3, "Mostrar el control del supervisor")
if st.button("Mostrar control", type="primary", disabled=not ready(3), key="d3"):
    G["s3"] = True
    st.rerun()
if G.get("s3"):
    d = next(x for x in S["decisions"] if x["decision_id"] == G["d1"])["summary"]
    comp = d["compliance"]
    passed = sum(k["passed"] for k in comp["checks"])
    st.success(f"El supervisor superó {passed} de {len(comp['checks'])} controles: horario permitido, consentimiento del cliente, sin lenguaje de presión, "
               f"ofertas condicionadas y opción de baja. Requiere aprobación humana siempre.")
    with st.expander("Ver los controles"):
        for k in comp["checks"]:
            st.markdown(f"{'✅' if k['passed'] else '❌'} **{k['rule_id']}** {k['description']}")

# 4 -------------------------------------------------------------------------
head(4, "Revisar la recomendación (aprobación humana)")
if G.get("s3"):
    d = next(x for x in S["decisions"] if x["decision_id"] == G["d1"])["summary"]
    st.markdown(f"**Propuesta:** {ui.STRATEGY.get(d['strategy']['code'])} por {ui.CHANNEL.get(d['strategy']['channel'])}")
    st.info(d["message"]["body"])
if st.button("✅ Aprobar como revisor humano", type="primary", disabled=not ready(4), key="d4"):
    try:
        with connect() as c:
            decision_service.review_decision(c, G["d1"], "analista-demo", "approve", "", actor_role="human")
        G["s4"] = True
        st.rerun()
    except decision_service.ReviewConflict as exc:
        st.error(ui.friendly_conflict(exc.detail))
if G.get("s4"):
    a = next((x for x in S["scheduled_actions"] if x["decision_id"] == G["d1"] and x["status"] in ("PENDING", "DUE")), None)
    if a:
        st.success(f"Aprobada. Gestión programada: {ui.ACTION.get(a['action_type'])} por {ui.CHANNEL.get(a['channel'])} el {ui.local(a['scheduled_at'])} (Lima). No se envió ningún mensaje real.")

# 5 -------------------------------------------------------------------------
head(5, "Simular la respuesta de María e interpretar con IA")
reply = st.text_area("Respuesta ficticia de María", "Hola, este mes me recortaron horas en el trabajo y no me alcanza. ¿Podría pagar la mitad el día 30 y el resto después?", key="d5txt", height=80)
if st.button("Simular respuesta y reanalizar", type="primary", disabled=not ready(5), key="d5"):
    ok, res = ui.send_event(cid, "CUSTOMER_REPLIED", "customer_channel", text=reply, channel="email")
    if not ok:
        st.error(res)
    else:
        out = ui.run_analysis(cid)
        if out["halted"]:
            st.error(out["reason"])
        else:
            G["s5"], G["d2"] = True, out["decision_id"]
            st.rerun()
if G.get("s5"):
    conv = ui.latest_by_agent(ui.runs(cid)).get("conversational_agent")
    ui.openai_panel(conv)
    st.caption("Segunda recomendación generada tras la respuesta: queda pendiente de aprobación humana.")

# 6 -------------------------------------------------------------------------
head(6, "Simular el pago confirmado por el banco")
if st.button("💳 Confirmar pago completo", type="primary", disabled=not ready(6), key="d6"):
    S0 = ui.state(cid)
    G["before"] = {"loan": S0["customer"]["outstanding_cents"], "pending": inst["amount_cents"] - inst["paid_cents"]}
    G["paid_inst"] = inst["installment_id"]  # tras el pago, 'current_installment' pasa a ser la cuota siguiente
    ok, res = ui.send_event(cid, "PAYMENT_POSTED", "bank_simulator", inst["installment_id"], payment_ref=f"PAY-{uuid.uuid4().hex[:8]}",
                            amount_cents=G["before"]["pending"], currency=cur)
    if ok:
        G["s6"], G["pay"] = True, res
        st.rerun()
    st.error(res)
if G.get("s6"):
    for line in ui.explain_changes(G["pay"]):
        st.markdown(f"- {line}")

# 7 -------------------------------------------------------------------------
head(7, "Nuevo saldo, cancelaciones y línea de tiempo")
if G.get("s6"):
    G["s7"] = True
    S2 = ui.state(cid)
    k = st.columns(3)
    k[0].markdown(ui.kpi("Saldo antes", ui.money(G["before"]["loan"], cur), "", "muted"), unsafe_allow_html=True)
    k[1].markdown(ui.kpi("Saldo ahora", ui.money(S2["customer"]["outstanding_cents"], cur), f"−{ui.money(G['before']['pending'], cur)}", "ok"), unsafe_allow_html=True)
    paid_inst = next(i for i in S2["installments"] if i["installment_id"] == G["paid_inst"])
    k[2].markdown(ui.kpi("Cuota pagada", ui.INSTALLMENT[paid_inst["status"]], f"cerrada {ui.local(paid_inst['closed_at'])}", "ok"), unsafe_allow_html=True)
    acts = [a for a in S2["scheduled_actions"] if a["installment_id"] == G["paid_inst"]]
    st.markdown("**Gestiones de esa cuota:** " + " · ".join(f"{ui.ACTION.get(a['action_type'], a['action_type'])} → {ui.badge(ui.ACTION_STATUS[a['status']], 'ok' if a['status'] == 'COMPLETED' else 'muted')}" for a in acts), unsafe_allow_html=True)
    stale = [x for x in S2["decisions"] if x["validity"] == "stale"]
    for x in stale:
        st.warning(f"Recomendación {x['decision_id'][:8]} invalidada: {x['stale_reason']}")
    if G.get("d2"):
        try:
            with connect() as c:
                decision_service.review_decision(c, G["d2"], "analista-demo", "approve", "", actor_role="human")
        except decision_service.ReviewConflict as exc:
            st.error(f"Si alguien intenta aprobar la segunda recomendación ahora: {ui.friendly_conflict(exc.detail)}")
    st.markdown("**Línea de tiempo**")
    for e in reversed(S2["events"][-8:]):
        st.markdown(f"- {ui.local(e['received_at'])} · {ui.EVENT.get(e['event_type'], e['event_type'])}")
    st.success("Caso completo: todo lo mostrado está guardado en SQLite y trazado en agent_runs.")
