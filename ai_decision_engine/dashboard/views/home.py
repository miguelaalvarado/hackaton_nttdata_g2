"""Portafolio: indicadores reales de SQLite y lista de clientes con estado comprensible."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import streamlit as st

from dashboard import ui
from app.db import connect
from app.seed import create_demo_case, seed_demo

ui.sidebar(select=False)
ui.hero("Portafolio de cobranza temprana", "Anticipamos el atraso con gestión empática, controlada y con aprobación humana. Cifras en vivo desde la base de datos.")
rows = ui.portfolio()

if not rows:
    ui.card("La base está vacía", "Carga los clientes sintéticos de demostración para comenzar. No se borra ni reemplaza nada existente.", "info")
    ok = st.checkbox("Confirmo cargar clientes sintéticos de demostración (solo agrega los que no existen)")
    if st.button("Cargar clientes demo", type="primary", disabled=not ok):
        with connect() as c:
            seed_demo(c)
        st.rerun()
    st.stop()

k = ui.kpis(rows)
cols = st.columns(5)
for col, (label, val, hint, kind) in zip(cols, [
        ("Clientes", k["clientes"], "en la base de datos", "info"),
        ("Casos prioritarios", k["prioritarios"], "vencidos, en disputa o por revisar", "bad" if k["prioritarios"] else "ok"),
        ("Próximas gestiones", k["gestiones"], "clientes con acción programada", "info"),
        ("Cuotas regularizadas", k["regularizadas"], "cuotas pagadas por completo", "ok"),
        ("Recomendaciones por aprobar", k["recomendaciones"], "esperan a una persona", "warn" if k["recomendaciones"] else "muted")]):
    col.markdown(ui.kpi(label, val, hint, kind), unsafe_allow_html=True)
st.caption("Prioritario = cuota vencida, disputa abierta, pago por verificar o reevaluación pendiente (regla visible, sin ponderaciones ocultas).")

st.markdown("### Clientes")
for r in sorted(rows, key=lambda r: (not r["priority"], -r["days_past_due"], r["first_name"])):
    inst, na = r["current_installment"], r["next_action"]
    cur = r["currency"] or "PEN"
    c1, c2, c3, c4 = st.columns([3.2, 2.2, 3.2, 1.6])
    c1.markdown(f'<div class="nx-person"><div class="nx-avatar" style="width:48px;height:48px;font-size:1.3rem">{ui.esc(r["first_name"][:1].upper())}</div>'
                f'<div><b style="font-size:1.1rem">{ui.esc(r["first_name"])}</b><br><span class="nx-small">{ui.esc(ui.PRODUCT.get(r["loan"]["product"], "") if r["loan"] else "")}</span></div></div>',
                unsafe_allow_html=True)
    c2.markdown(f'{ui.status_badge(r)}<br><span class="nx-small">Saldo {ui.money(r["outstanding_cents"], cur)}</span>', unsafe_allow_html=True)
    c3.markdown((f'<b>{ui.esc(ui.ACTION.get(na["action_type"], na["action_type"]))}</b><br><span class="nx-small">{ui.esc(ui.CHANNEL.get(na["channel"], "interno"))} · {ui.local(na["scheduled_at"])}</span>'
                 if na else '<span class="nx-small">Sin acción programada</span>')
                + ("".join(ui.badge(x, "warn") for x in r["priority_reasons"][:2]) and "<br>" + "".join(ui.badge(x, "warn") for x in r["priority_reasons"][:2])), unsafe_allow_html=True)
    if c4.button("Abrir", key=f"open-{r['customer_id']}"):
        st.session_state["cid"] = r["customer_id"]
        st.switch_page("views/cliente360.py")
    st.divider()

with st.expander("Datos de demostración"):
    st.caption("Agrega clientes sintéticos nuevos sin modificar los existentes.")
    ok2 = st.checkbox("Confirmo agregar un caso nuevo de María (cuota vencida hace 3 días)", key="confirm-maria")
    if st.button("Agregar caso de María", disabled=not ok2):
        with connect() as c:
            st.session_state["cid"] = create_demo_case(c, first_name="María")
        st.rerun()
    ok3 = st.checkbox("Confirmo cargar los clientes demo estándar faltantes", key="confirm-seed")
    if st.button("Cargar clientes demo estándar", disabled=not ok3):
        with connect() as c:
            st.write(seed_demo(c))
