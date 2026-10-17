"""Mapa visual del orquestador y los 7 componentes, alimentado por las trazas REALES de agent_runs."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import streamlit as st

from app.calendar_pe import LIMA
from app.db import connect, db_path
from app.orchestrator import COMPONENTS
from app.repositories import AgentRunRepo

st.set_page_config(page_title="NEXO AI · Mapa de componentes", layout="wide")
st.title("Mapa de componentes · trazas reales")


def local(iso):
    return datetime.fromisoformat(iso).astimezone(LIMA).strftime("%d/%m %H:%M:%S") if iso else "—"


with connect() as c:
    runs = AgentRunRepo(c).list(limit=500)
    customers = [r[0] for r in c.execute("SELECT customer_id FROM customers ORDER BY customer_id")]
for r in runs:
    r["input"], r["output"] = json.loads(r.pop("input_json")), json.loads(r.pop("output_json"))

scope = st.selectbox("Filtrar por cliente", ["(todos)"] + customers)
if scope != "(todos)":
    runs = [r for r in runs if r["customer_id"] == scope]
st.caption(f"BD `{db_path()}` · {len(runs)} corridas · motor = lo que dice cada traza, no lo que aspiramos a tener")

stats = {}
for cid_, label, desc, src, llm_capable in COMPONENTS:
    mine = [r for r in runs if r["agent_name"] == cid_]
    engines = sorted({r["output"].get("engine", "rules") for r in mine})
    stats[cid_] = {"runs": len(mine), "last": mine[0] if mine else None, "engines": engines or ["rules"]}

COLOR = {"rules": "#dbeafe", "llm": "#bbf7d0", "none": "#f3f4f6"}


def kind(cid_):
    e = stats[cid_]["engines"]
    if stats[cid_]["runs"] == 0:
        return "none"
    return "llm" if any(x.startswith("llm") for x in e) else "rules"


dot = ['digraph G { rankdir=TB; nodesep=0.4; ranksep=0.35; node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=12, width=2.6, height=0.5]; edge [color="#6b7280"];']
for cid_, label, desc, src, llm_capable in COMPONENTS:
    s = stats[cid_]
    badge = {"rules": "REGLAS", "llm": "IA (LLM)", "none": "sin corridas"}[kind(cid_)]
    dot.append(f'"{cid_}" [label="{label}\\n{badge} · {s["runs"]} corr.", fillcolor="{COLOR[kind(cid_)]}"];')
dot.append('"human" [label="Revisión humana\\n(persona)", fillcolor="#fde68a"];')
dot.append('"db" [label="SQLite\\n(fuente de verdad)", shape=cylinder, fillcolor="#e5e7eb"];')
chain = ["orchestrator", "risk_agent", "strategy_agent", "contact_agent", "conversational_agent", "negotiation_agent", "compliance_agent", "human", "followup_learning"]
for a, b in zip(chain, chain[1:]):
    dot.append(f'"{a}" -> "{b}";')
dot.append('"followup_learning" -> "db" [style=dashed]; "db" -> "orchestrator" [style=dashed, label="estado vigente"];')
dot.append("}")
st.graphviz_chart("\n".join(dot), width="content")
st.markdown("🟦 **REGLAS** = determinista (sin IA generativa) &nbsp; 🟩 **IA (LLM)** = la traza registra `llm:<modelo>` &nbsp; ⬜ sin corridas &nbsp; 🟨 persona")

conv_runs = [r for r in runs if r["agent_name"] == "conversational_agent"]
n_ai = sum(r["output"].get("engine", "").startswith("llm:openai") for r in conv_runs)
n_fb = sum(bool(r["output"].get("fallback")) for r in conv_runs)
m1, m2, m3 = st.columns(3)
m1.metric("Ejecuciones con OpenAI real", n_ai)
m2.metric("Fallbacks a reglas (API falló)", n_fb)
m3.metric("Solo reglas", len(conv_runs) - n_ai - n_fb)
any_llm = any(kind(c[0]) == "llm" for c in COMPONENTS)
if any_llm:
    st.success("Hay corridas con LLM real en este conjunto (ver `engine` en la traza del Conversational Agent).")
else:
    st.warning("**Ninguna corrida usa IA generativa.** Los 8 componentes son reglas/plantillas deterministas. El Conversational Agent tiene un "
               "adaptador LLM opcional (`app/llm.py`) que solo se activa con `ANTHROPIC_API_KEY`; hasta entonces su traza dirá `rules`.")

st.subheader("Componentes")
for cid_, label, desc, src, llm_capable in COMPONENTS:
    s = stats[cid_]
    with st.expander(f"{label} · {', '.join(s['engines']) if s['runs'] else 'sin corridas'} · {s['runs']} corridas · última {local(s['last']['started_at']) if s['last'] else '—'}"):
        st.write(f"{desc}  \n**Implementación:** `{src}`  \n**Puede usar LLM:** {'sí (opcional)' if llm_capable else 'no'}")
        mine = [r for r in runs if r["agent_name"] == cid_][:3]
        if not mine:
            st.caption("Aún no hay trazas: ejecuta la demo guiada.")
        for r in mine:
            st.caption(f"{local(r['started_at'])} · cliente {r['customer_id']} · case_version {r['case_version']} · {r['status']} · trigger `{r['trigger']}`"
                       + (f" · decisión `{r['decision_id'][:8]}`" if r["decision_id"] else ""))
            st.json({"input": r["input"], "output": r["output"]}, expanded=False)

st.subheader("Línea de tiempo de corridas")
st.dataframe([{"Hora": local(r["started_at"]), "Componente": r["agent_name"], "Cliente": r["customer_id"], "Motor": r["output"].get("engine", "rules") + (" ⚠ fallback" if r["output"].get("fallback") else ""),
               "Herramientas": ", ".join(r["output"].get("tools_used", [])), "ms": r["output"].get("duration_ms", ""),
               "Estado": r["status"], "Trigger": r["trigger"], "Decisión": (r["decision_id"] or "")[:8]} for r in runs[:100]],
             hide_index=True, width="stretch")
