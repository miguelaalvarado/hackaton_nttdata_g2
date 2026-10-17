"""Expediente del cliente (Customer 360): resumen, siguiente mejor acción, eventos y seguimiento, historial."""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import streamlit as st

from dashboard import ui
from app import decision_service
from app.db import connect

cid = ui.sidebar()
ui.hero("Expediente del cliente", "Todo lo que sabemos, lo que recomienda el equipo de agentes y qué pasa cuando algo cambia.")
if not cid:
    st.stop()
S = ui.state(cid)
c = S["customer"]
inst = c["current_installment"]
cur = S["loans"][0]["currency"] if S["loans"] else "PEN"
ui.customer_header(S)

t1, t2, t3, t4, t5 = st.tabs(["Resumen", "Siguiente mejor acción", "Simular eventos", "Historial", "Avanzado"])

# --------------------------------------------------------------------------- Resumen
with t1:
    a, b = st.columns(2)
    with a:
        ui.card("Señales verificables", "<ul style='margin:0;padding-left:1.1rem'>" + "".join(f"<li>{ui.esc(s)}</li>" for s in ui.signals(S)) + "</ul>",
                sub="Cada señal sale de un dato guardado en la base")
    with b:
        na = c["next_action"]
        if na:
            ui.card("Próxima acción", f"<b>{ui.esc(ui.ACTION.get(na['action_type'], na['action_type']))}</b> por <b>{ui.esc(ui.CHANNEL.get(na['channel'], 'revisión interna'))}</b><br>"
                    f"{ui.esc(ui.local(na['scheduled_at']))} (hora de Lima) · {ui.badge(ui.ACTION_STATUS[na['status']], 'info')}<br>"
                    f"<span class='nx-small'>{ui.esc(na['reason'])}</span>", "info")
        else:
            blocked = c["blocked_actions"]
            ui.card("Próxima acción", "Sin acción programada." + (f"<br><span class='nx-small'>{ui.esc(blocked[0]['status_reason'])}</span>" if blocked else ""), "warn" if blocked else None)
    with st.expander("Cuotas del préstamo", expanded=True):
        for i in S["installments"]:
            st.markdown(f"**Cuota {i['sequence']}** · vence {i['due_date']} · {ui.money(i['amount_cents'], cur)} · pagado {ui.money(i['paid_cents'], cur)} · "
                        f"{ui.badge(ui.INSTALLMENT[i['status']], 'ok' if i['status'] == 'PAID' else ('warn' if i['status'] == 'PARTIAL' else 'info'))}", unsafe_allow_html=True)

# ------------------------------------------------------------ Siguiente mejor acción
with t2:
    decisions = S["decisions"]
    live = next((d for d in decisions if d["review_status"] == "pending" and d["validity"] == "valid"), None)
    shown = live or (decisions[0] if decisions else None)
    cA, cB = st.columns([3, 1])
    cB.markdown("&nbsp;")
    if cB.button("Ejecutar análisis", type="primary", key="run360"):
        out = ui.run_analysis(cid)
        st.error(out["reason"]) if out["halted"] else st.rerun()
    if shown is None:
        cA.info("Aún no hay recomendación para este cliente. Pulsa **Ejecutar análisis** para que el equipo de agentes proponga una.")
    else:
        d = shown["summary"]
        strat, msg, comp = d["strategy"], d["message"], d["compliance"]
        state_badge = (ui.badge("Pendiente de aprobación humana", "warn") if shown["review_status"] == "pending" and shown["validity"] == "valid" else
                       ui.badge("OBSOLETA", "bad") if shown["validity"] == "stale" else
                       ui.badge("Aprobada", "ok") if shown["review_status"] == "approved" else ui.badge("Rechazada", "muted"))
        cA.markdown(f"### Recomendación {state_badge}", unsafe_allow_html=True)
        if shown["validity"] == "stale":
            st.error(f"Esta recomendación quedó obsoleta: {shown['stale_reason']}. No se puede aprobar; hay que reevaluar.")
        when = f"{strat['contact_date']} a las {strat['contact_hour']:02d}:00" if strat.get("contact_date") else f"{strat['contact_hour']:02d}:00"
        x, y = st.columns(2)
        with x:
            ui.card("Qué se propone", f"<b>Estrategia:</b> {ui.esc(ui.STRATEGY.get(strat['code'], strat['code']))}<br><b>Canal:</b> {ui.esc(ui.CHANNEL.get(strat['channel'], strat['channel']))}<br>"
                    f"<b>Cuándo:</b> {ui.esc(when)} (Lima)<br><b>Horario permitido:</b> 08:00–20:00, y solo días hábiles para llamadas/visitas<br>"
                    + ("<b>Opciones (sujetas a evaluación):</b><ul style='margin:.2rem 0'>" + "".join(f"<li>{ui.esc(o)}</li>" for o in strat["proposed_offers"]) + "</ul>" if strat["proposed_offers"] else ""), "info")
            st.markdown("**Mensaje propuesto** (borrador, no se envía):")
            st.info(msg["body"])
        with y:
            passed = sum(1 for k in comp["checks"] if k["passed"])
            ui.card("Control del supervisor", f"{ui.badge('Cumple' if comp['status'] == 'pending_human_approval' else 'BLOQUEADA', 'ok' if comp['status'] == 'pending_human_approval' else 'bad')} "
                    f"{passed} de {len(comp['checks'])} controles superados"
                    + ("".join(f"<br>{ui.badge('Falla', 'bad')} {ui.esc(v)}" for v in comp["violations"]) if comp["violations"] else ""), "ok" if not comp["violations"] else "bad")
            ev = d["interpretation"]["evidence"]
            ui.card("Motivos y evidencia", f"<b>Riesgo {ui.esc(d['interpretation']['band'])}</b> · {ui.esc(d['interpretation']['summary'])}<ul style='margin:.3rem 0'>"
                    + "".join(f"<li>{ui.esc(ui.FIELD.get(e['field'], e['field']))}: <b>{ui.esc(e['value'])}</b> — {ui.esc(e['reading'])}</li>" for e in ev) + "</ul>"
                    + "".join(f"<div class='nx-small'>⚠ {ui.esc(n)}</div>" for n in d["alignment_notes"]))
        with st.expander("Ver los controles de cumplimiento uno por uno"):
            for k in comp["checks"]:
                st.markdown(f"{'✅' if k['passed'] else '❌'} **{k['rule_id']}** {k['description']}" + ("" if k["passed"] else f" — _{k['detail']}_"))
        if shown["review_status"] == "pending":
            st.markdown("#### Decisión humana")
            who = st.text_input("Revisor", "analista-demo", key="reviewer360")
            b1, b2, _ = st.columns([1, 1, 2])
            can = shown["validity"] == "valid" and comp["status"] == "pending_human_approval"
            if b1.button("✅ Aprobar", type="primary", disabled=not can, key="ap360"):
                try:
                    with connect() as cn:
                        r = decision_service.review_decision(cn, shown["decision_id"], who, "approve", "", actor_role="human")
                    st.session_state["flash"] = ("ok", "Aprobada. No se envió ningún mensaje real: quedó programada una gestión simulada.")
                    st.rerun()
                except decision_service.ReviewConflict as exc:
                    st.error(ui.friendly_conflict(exc.detail))
            if b2.button("✖ Rechazar", key="rj360"):
                with connect() as cn:
                    decision_service.review_decision(cn, shown["decision_id"], who, "reject", "", actor_role="human")
                st.rerun()
            st.caption("Consola humana local de confianza. En una aplicación publicada, la revisión exige autenticar a la persona.")
        else:
            st.caption(f"Revisada por {shown.get('reviewer_id') or '—'}.")
    if "flash" in st.session_state:
        kind, msg_ = st.session_state.pop("flash")
        st.success(msg_)

# ------------------------------------------------------------------ Simular eventos
with t3:
    st.markdown("Cada botón registra un **evento real** en la base y reevalúa el expediente.")
    if not inst:
        st.success("Todas las cuotas están regularizadas.")
    else:
        iid, rem = inst["installment_id"], inst["amount_cents"] - inst["paid_cents"]
        e1, e2 = st.columns(2)
        with e1:
            ui.card("Respuesta del cliente", "Se guarda en la conversación y marca el caso para reevaluar.")
            txt = st.text_area("Mensaje ficticio", "Este mes me recortaron horas y no me alcanza. ¿Puedo pagar más adelante?", key="ev_txt", height=80)
            if st.button("💬 Simular respuesta", key="ev_reply"):
                st.session_state["last_event"] = ui.send_event(cid, "CUSTOMER_REPLIED", "customer_channel", text=txt, channel="email")
                st.rerun()
            ui.card("Compromiso de pago", "Se registra la promesa. NO cuenta como pago.")
            pdate = st.date_input("Fecha prometida", date.today() + timedelta(days=5), key="ev_pdate")
            if st.button("🤝 Simular compromiso", key="ev_promise"):
                st.session_state["last_event"] = ui.send_event(cid, "PROMISE_CREATED", "customer_channel", iid, amount_cents=rem, promised_date=pdate.isoformat())
                st.rerun()
        with e2:
            ui.card("Pagos (simulador bancario)", f"Pendiente de la cuota: <b>{ui.money(rem, cur)}</b>. Solo el simulador bancario puede confirmar pagos.")
            pct = st.slider("Porcentaje del pago parcial", 10, 90, 40, 10, key="ev_pct")
            p1, p2 = st.columns(2)
            if p1.button("💳 Pago completo", type="primary", key="ev_full"):
                st.session_state["last_event"] = ui.send_event(cid, "PAYMENT_POSTED", "bank_simulator", iid, payment_ref=f"PAY-{ui.uuid.uuid4().hex[:8]}", amount_cents=rem, currency=cur)
                st.rerun()
            if p2.button("💳 Pago parcial", key="ev_part"):
                st.session_state["last_event"] = ui.send_event(cid, "PAYMENT_POSTED", "bank_simulator", iid, payment_ref=f"PAY-{ui.uuid.uuid4().hex[:8]}", amount_cents=max(1, rem * pct // 100), currency=cur)
                st.rerun()
            ui.card("Disputa", "El cliente no reconoce el cobro: se suspende la cobranza hasta revisión humana.")
            if st.button("⚖️ Simular disputa", key="ev_disp"):
                st.session_state["last_event"] = ui.send_event(cid, "DISPUTE_OPENED", "customer_channel", reason="El cliente no reconoce el cobro (demo)")
                st.rerun()
    if "last_event" in st.session_state:
        ok, res = st.session_state["last_event"]
        if ok:
            st.markdown("#### Qué cambió (traza real del evento)")
            for line in ui.explain_changes(res) or ["Evento registrado sin cambios financieros."]:
                st.markdown(f"- {line}")
            if res["status"] == "DUPLICATE":
                st.warning("El evento era un duplicado y no se contó dos veces.")
            S2 = ui.state(cid)
            na = S2["customer"]["next_action"]
            st.markdown(f"**Próxima revisión:** " + (f"{ui.ACTION.get(na['action_type'], na['action_type'])} el {ui.local(na['scheduled_at'])}" if na else "sin gestión programada"))
            closed = [a for a in S2["scheduled_actions"] if a["status"] in ("CANCELLED", "BLOCKED")][:4]
            if closed:
                st.markdown("**Gestiones anteriores afectadas:** " + " · ".join(f"{ui.ACTION.get(a['action_type'], a['action_type'])} → {ui.ACTION_STATUS[a['status']]}" for a in closed))
        else:
            st.error(f"Rechazado: {res}")

# ------------------------------------------------------------------------ Historial
with t4:
    st.markdown("#### Línea de tiempo")
    for e in reversed(S["events"]):
        badge_ = {"PROCESSED": ui.badge("Procesado", "ok"), "DUPLICATE": ui.badge("Duplicado ignorado", "warn"), "REJECTED": ui.badge("Rechazado", "bad")}[e["status"]]
        st.markdown(f"**{ui.local(e['received_at'])}** · {ui.esc(ui.EVENT.get(e['event_type'], e['event_type']))} {badge_}", unsafe_allow_html=True)
        if e["reason"]:
            st.caption(e["reason"])
    if not S["events"]:
        st.caption("Sin eventos todavía.")
    h1, h2 = st.columns(2)
    with h1:
        st.markdown("#### Pagos")
        for p in S["payments"]:
            st.markdown(f"{ui.local(p['posted_at'])} · {ui.money(p['amount_cents'], p['currency'])} · {ui.badge({'CONFIRMED': 'Confirmado', 'PENDING': 'Pendiente', 'REVERSED': 'Revertido', 'FAILED': 'Fallido'}[p['status']], 'ok' if p['status'] == 'CONFIRMED' else 'warn')}", unsafe_allow_html=True)
        if not S["payments"]:
            st.caption("Sin pagos.")
    with h2:
        st.markdown("#### Contactos y conversación")
        for x in S["contact_history"][:8]:
            st.markdown(f"{ui.local(x['occurred_at'])} · {ui.CHANNEL.get(x['channel'], x['channel'])} · {'enviado (simulado)' if x['direction'] == 'outbound' else 'respuesta del cliente'}")
        for m in S["conversations"][-4:]:
            st.chat_message("user" if m["sender"] == "customer" else "assistant").write(m["text"])

# ------------------------------------------------------------------------ Avanzado
with t5:
    st.caption("Identificadores y datos técnicos (solo para auditoría).")
    st.json({"customer_id": cid, "case_version": c["case_version"], "needs_reevaluation": bool(c["needs_reevaluation"]), "reevaluation_reason": c["reevaluation_reason"],
             "loans": [l["loan_id"] for l in S["loans"]], "installments": [i["installment_id"] for i in S["installments"]],
             "decisions": [{"id": d["decision_id"], "version": d["case_version"], "validity": d["validity"], "review": d["review_status"]} for d in S["decisions"]],
             "scheduled_actions": [{"id": a["action_id"], "type": a["action_type"], "status": a["status"], "decision_id": a["decision_id"]} for a in S["scheduled_actions"]]})
