"""Agentes en vivo: tres funciones de negocio (ANALISTA, GESTOR IA, SUPERVISOR) sobre los 7 componentes. Todo sale de agent_runs."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import streamlit as st

from dashboard import ui

cid = ui.sidebar()
ui.hero("Agentes en vivo", "Un orquestador coordina tres funciones de negocio. Lo que ves son trazas reales guardadas en la base, no animaciones.")
if not cid:
    st.stop()

top = st.columns([3, 1])
top[0].markdown("El análisis consulta el expediente, evalúa riesgo, propone estrategia y canal, redacta el mensaje, lo valida con Cumplimiento y lo deja **pendiente de aprobación humana**. No se envía nada.")
if top[1].button("▶ Ejecutar análisis", type="primary", key="run-agentes"):
    with st.spinner("Orquestando agentes…"):
        out = ui.run_analysis(cid)
    if out["halted"]:
        st.warning(f"El orquestador se detuvo de forma segura: {out['reason']}")

rs = ui.runs(cid)
orch_runs = [r for r in rs if r["agent_name"] == "orchestrator" and r["trigger"].startswith("orchestrator:")]
last_trigger = orch_runs[0]["trigger"] if orch_runs else None
this = ui.latest_by_agent([r for r in rs if r["trigger"] == last_trigger]) if last_trigger else {}
follow = ui.latest_by_agent(rs).get("followup_learning")

if not orch_runs:
    st.info("Este cliente aún no tiene un análisis ejecutado. Pulsa **Ejecutar análisis**.")
    st.stop()

o = orch_runs[0]
halted = o["output"].get("halted")
st.markdown(
    f'<div class="nx-card" style="border-left:6px solid #1D4ED8"><div class="nx-role">ORQUESTADOR</div><div class="nx-card-body">'
    f'{ui.badge("REGLAS", "info")} Último análisis: <b>{ui.local(o["started_at"], "%d/%m/%Y %H:%M:%S")}</b> · '
    + (f'se detuvo de forma segura: {ui.esc(o["output"].get("reason"))}' if halted else f'consultó el expediente (versión {o["output"].get("case_version")})') +
    '</div></div>', unsafe_allow_html=True)


def summary(name: str, r: dict | None) -> str:
    if r is None:
        return "Sin ejecutar en este análisis"
    x = r["output"]
    if name == "risk_agent":
        return f"Riesgo {ui.esc(x.get('band'))} (puntaje {x.get('score'):.0f}), confianza {ui.esc(x.get('confidence'))}"
    if name == "strategy_agent":
        return f"Estrategia: {ui.esc(ui.STRATEGY.get(x.get('code'), x.get('code')))}"
    if name == "contact_agent":
        return (f"{ui.esc(ui.CHANNEL.get(x.get('channel'), x.get('channel')))} · {ui.esc(ui.local(x.get('scheduled_at')))}" if x.get("channel") else ui.esc(x.get("reason", "")))
    if name == "conversational_agent":
        if ui.engine_kind(x) == "ai":
            return f"Interpretó: {ui.esc(ui.INTENT.get(x.get('customer_intent'), x.get('customer_intent')))} y redactó el mensaje"
        return "Redactó el mensaje con plantillas"
    if name == "negotiation_agent":
        return f"{len(x.get('offers', []))} opción(es) de apoyo, todas condicionadas"
    if name == "compliance_agent":
        return ("Cumple los controles" if x.get("status") == "pending_human_approval" else f"BLOQUEADA: {ui.esc('; '.join(x.get('violations', [])))}")
    if name == "followup_learning":
        p = x.get("plan", {})
        return f"Próxima gestión: {ui.esc(ui.ACTION.get(p.get('action_type'), p.get('action_type') or 'ninguna'))}" + (f" · {ui.esc(ui.local(p.get('scheduled_at')))}" if p.get("scheduled_at") else "")
    return ""


ROLES = [("ANALISTA", "Riesgo, Estrategia y Contacto", ["risk_agent", "strategy_agent", "contact_agent"]),
         ("GESTOR IA", "Conversacional y Negociación", ["conversational_agent", "negotiation_agent"]),
         ("SUPERVISOR", "Cumplimiento y Seguimiento", ["compliance_agent", "followup_learning"])]
cols = st.columns(3)
for col, (role, sub, names) in zip(cols, ROLES):
    with col:
        st.markdown(f'<div class="nx-role">{role}</div><div class="nx-small">{sub}</div>', unsafe_allow_html=True)
        for n in names:
            r = follow if n == "followup_learning" else this.get(n)
            body = (f'<div class="nx-comp"><b>{ui.COMPONENT_LABEL[n]}</b> '
                    + (ui.engine_badge(r["output"]) if r else ui.badge("sin traza", "muted"))
                    + f'<div class="nx-small">{ui.COMPONENT_WHAT[n]}</div><div style="margin-top:.25rem">{summary(n, r)}</div>'
                    + (f'<div class="nx-small">{ui.local(r["started_at"], "%H:%M:%S")} · traza {ui.esc(r["run_id"])}</div>' if r else "") + '</div>')
            st.markdown(body, unsafe_allow_html=True)
            if r:
                with st.expander(f"Ver traza · {ui.COMPONENT_LABEL[n]}"):
                    st.json({"entrada": r["input"], "salida": r["output"]}, expanded=False)

st.markdown("---")
ui.openai_panel(this.get("conversational_agent"))
st.markdown(
    f'{ui.badge("REGLAS", "info")} componente determinista, sin IA generativa &nbsp; {ui.badge("IA REAL · OpenAI", "ai")} ejecutó un LLM (solo si la traza lo respalda) '
    f'&nbsp; {ui.badge("FALLBACK A REGLAS", "warn")} se intentó la IA y falló', unsafe_allow_html=True)
st.caption("Solo el Gestor IA (componente Conversacional) puede usar un LLM. El canal y el horario los decide Contacto por reglas; el LLM nunca registra pagos, aprueba ni modifica contratos.")

with st.expander("Resumen de todas las ejecuciones guardadas (todos los clientes)"):
    allr = [r for r in ui.runs(None, 500) if r["agent_name"] == "conversational_agent"]
    n_ai = sum(ui.engine_kind(r["output"]) == "ai" for r in allr)
    n_fb = sum(ui.engine_kind(r["output"]) == "fallback" for r in allr)
    m = st.columns(3)
    m[0].markdown(ui.kpi("Con IA real", n_ai, "trazas verificadas", "ai" if n_ai else "muted"), unsafe_allow_html=True)
    m[1].markdown(ui.kpi("Fallbacks", n_fb, "OpenAI falló → reglas", "warn" if n_fb else "muted"), unsafe_allow_html=True)
    m[2].markdown(ui.kpi("Solo reglas", len(allr) - n_ai - n_fb, "sin IA generativa", "info"), unsafe_allow_html=True)
