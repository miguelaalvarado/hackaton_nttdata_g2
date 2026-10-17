"""NEXO AI Demo Arena: vistas de negocio sobre SQLite real. Clics reales (AppTest) + verificación de la base."""
import json
import sqlite3
from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest

V = Path(__file__).resolve().parent.parent / "dashboard" / "views"


def page(name, **kw):
    return AppTest.from_file(str(V / f"{name}.py"), default_timeout=60)


def texts(at):
    return " ".join([m.value for m in at.markdown] + [s.value for s in at.success] + [s.value for s in at.info]
                    + [s.value for s in at.warning] + [s.value for s in at.error] + [s.value for s in at.sidebar.markdown])


def click(at, label, exact=False):
    btn = [b for b in at.button if (b.label == label if exact else label in b.label)]
    assert btn, f"botón '{label}' no encontrado; hay: {[b.label for b in at.button]}"
    assert not btn[0].disabled, f"'{label}' deshabilitado"
    btn[0].click(); at.run()
    assert not at.exception, (label, at.exception)


@pytest.fixture()
def seeded(isolated_db):
    from app.db import connect
    from app.seed import seed_demo
    with connect() as c:
        seed_demo(c)
    return isolated_db


def q(db, sql):
    return sqlite3.connect(db).execute(sql).fetchall()


# ---------------------------------------------------------------- Portafolio
def test_home_kpis_come_from_sqlite_and_empty_state_needs_confirmation(isolated_db):
    at = page("home").run()
    assert not at.exception and "La base está vacía" in texts(at)
    assert [b for b in at.button if "Cargar clientes demo" in b.label][0].disabled  # sin confirmar no carga
    at.checkbox[0].check().run()
    click(at, "Cargar clientes demo")
    t = texts(at)
    n = q(isolated_db, "select count(*) from customers")[0][0]
    assert n == 4 and f'nx-kpi-value" style="color:#1E40AF">{n}<' in t.replace("\n", "")
    assert "Casos prioritarios" in t and "Cuotas regularizadas" in t and "Próximas gestiones" in t
    for name in ("Lucía", "Carlos", "Marta", "Jorge"):
        assert name in t


def test_home_demo_data_never_replaces_existing(seeded):
    before = q(seeded, "select customer_id, case_version from customers order by 1")
    at = page("home").run()
    exp = [e for e in at.expander if "Datos de demostración" in e.label][0]
    cb = [c for c in at.checkbox if "María" in c.label][0]
    btn = [b for b in at.button if "Agregar caso de María" in b.label][0]
    assert btn.disabled
    cb.check().run()
    click(at, "Agregar caso de María")
    after = q(seeded, "select customer_id, case_version from customers order by 1")
    assert len(after) == len(before) + 1 and all(row in after for row in before)


# --------------------------------------------------------------- Expediente
def test_customer_360_uses_business_language_and_hides_technical_ids(seeded):
    at = page("cliente360").run()
    assert not at.exception
    t = texts(at)
    for must in ("Señales verificables", "Próxima acción", "Pendiente de la cuota", "Saldo del préstamo"):
        assert must in t
    assert "case_version" not in t and "CLI-0" not in t and "IN-0" not in t       # los ids técnicos solo en 'Avanzado'
    assert any("CLI-0" in json.dumps(j.value) for j in at.json)                      # ...y ahí sí aparecen


def test_events_update_database_and_explain_payment_cancellation_and_stale_decisions(seeded):
    at = page("cliente360").run()
    cid = at.selectbox[0].value
    click(at, "Ejecutar análisis")
    dec = q(seeded, f"select decision_id, validity from decisions where customer_id='{cid}'")
    assert len(dec) == 1 and dec[0][1] == "valid"
    pending_before = q(seeded, f"select amount_cents-paid_cents from installments where customer_id='{cid}' and sequence=1")[0][0]
    click(at, "Pago parcial")
    assert "OBSOLETAS" in texts(at).upper() and "Qué cambió" in texts(at)  # la invalidación se explica al ocurrir
    assert q(seeded, f"select paid_cents from installments where customer_id='{cid}' and sequence=1")[0][0] == max(1, pending_before * 40 // 100)
    assert q(seeded, f"select validity from decisions where customer_id='{cid}'") == [("stale",)]
    click(at, "Pago completo")
    assert q(seeded, f"select status from installments where customer_id='{cid}' and sequence=1") == [("PAID",)]
    t = texts(at)
    assert "Qué cambió" in t and "Cuota regularizada" in t and "cancelada" in t
    assert q(seeded, f"select count(*) from scheduled_actions where customer_id='{cid}' and installment_id like '%-1' and status in ('PENDING','DUE','BLOCKED')") == [(0,)]


def test_stale_recommendation_cannot_be_approved_in_ui(seeded):
    at = page("cliente360").run()
    cid = at.selectbox[0].value
    click(at, "Ejecutar análisis")
    click(at, "Pago parcial")
    at.run()
    assert "OBSOLETA" in texts(at)
    assert not [b for b in at.button if "Aprobar" in b.label and not b.disabled]


def test_dispute_event_suspends_collection(seeded):
    at = page("cliente360").run()
    cid = at.selectbox[0].value
    click(at, "Simular disputa")
    assert q(seeded, f"select dispute_open from customers where customer_id='{cid}'") == [(1,)]
    assert "Disputa abierta" in texts(at)


# ----------------------------------------------------- Agentes: honestidad del motor
def _run_and_open_agents(seeded):
    at = page("agentes").run()
    click(at, "Ejecutar análisis")
    return at


def test_agents_view_without_ai_shows_rules_and_never_claims_real_ai(seeded):
    at = _run_and_open_agents(seeded)
    t = texts(at)
    for role in ("ANALISTA", "GESTOR IA", "SUPERVISOR", "ORQUESTADOR"):
        assert role in t
    for comp in ("Riesgo", "Estrategia", "Contacto", "Conversacional", "Negociación", "Cumplimiento", "Seguimiento"):
        assert comp in t
    assert "REGLAS" in t and "NO usó IA generativa" in t
    assert "IA REAL" not in t.replace("IA REAL · OpenAI</span> ejecutó", "")  # solo aparece en la leyenda, nunca como estado de la traza
    assert "verificada en agent_runs" not in t


def test_agents_view_proves_real_ai_only_from_traces(seeded, monkeypatch):
    from app import llm
    from tests.test_openai_agent import FakeOpenAI, FINAL, call, resp
    monkeypatch.setenv("LLM_PROVIDER", "openai"); monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real"); monkeypatch.setenv("OPENAI_MODEL", "test-model")

    class Smart(FakeOpenAI):
        def _create(self, **kw):
            cid = json.loads(kw["input"][0]["content"])["customer_id"]
            self.turns = [resp([call("get_customer_file", customer_id=cid), call("get_commitments", customer_id=cid)]), resp(text=json.dumps(FINAL))][len(self.calls):]
            return super()._create(**kw)
    monkeypatch.setattr(llm, "openai_client", lambda: Smart([None]))
    t = texts(_run_and_open_agents(seeded))
    assert "IA REAL · OpenAI" in t and "verificada en agent_runs" in t and "test-model" in t
    assert "get_customer_file" in t and "get_commitments" in t and "entrada" in t and "salida" in t
    assert "Pide más tiempo" in t  # interpretación traducida a lenguaje de negocio

    monkeypatch.setattr(llm, "openai_client", lambda: FakeOpenAI([RuntimeError("503 simulado")]))
    t2 = texts(_run_and_open_agents(seeded))
    assert "FALLBACK A REGLAS" in t2 and "503 simulado" in t2 and "verificada en agent_runs" not in t2


# ---------------------------------------------------------------- Demo 2 minutos
def test_two_minute_demo_with_maria_end_to_end(seeded):
    existing = q(seeded, "select customer_id, case_version from customers order by 1")
    at = page("demo").run()
    assert "Falta el caso de María" in texts(at)
    assert [b for b in at.button if "Crear caso de María" in b.label][0].disabled
    at.checkbox[0].check().run()
    click(at, "Crear caso de María")
    cid = q(seeded, "select customer_id from customers where first_name='María'")[0][0]
    for label in ("Abrir expediente", "Ejecutar análisis", "Mostrar control", "Aprobar como revisor humano", "Simular respuesta y reanalizar",
                  "Confirmar pago completo"):
        click(at, label)
    t = texts(at)
    assert "Saldo antes" in t and "Saldo ahora" in t and "invalidada" in t
    # lo que se VE en el paso 7 debe ser la cuota pagada (no la siguiente)
    kpi_cuota = next(m.value for m in at.markdown if ">Cuota pagada<" in m.value)
    assert "Regularizada" in kpi_cuota and "Pendiente" not in kpi_cuota
    gest = next(m.value for m in at.markdown if "Gestiones de esa cuota" in m.value)
    assert "Cancelada" in gest and "Programada" not in gest
    assert q(seeded, f"select review_status, validity from decisions where customer_id='{cid}' order by created_at") == [("approved", "valid"), ("pending", "stale")]
    assert q(seeded, f"select status from installments where customer_id='{cid}' and sequence=1") == [("PAID",)]
    assert q(seeded, f"select outstanding_cents from loans where customer_id='{cid}'") == [(800000 - 65000,)]
    assert q(seeded, f"select count(*) from payments where customer_id='{cid}' and status='CONFIRMED'") == [(1,)]
    assert q(seeded, f"select outcome from contact_history where customer_id='{cid}' and direction='outbound'") == []  # nada se envió
    assert q(seeded, f"select count(*) from agent_runs where customer_id='{cid}' and agent_name='risk_agent'")[0][0] == 2
    after = q(seeded, "select customer_id, case_version from customers order by 1")
    assert all(r in after for r in existing)  # los clientes previos no se tocaron


def test_demo_steps_cannot_be_skipped(seeded):
    from app.db import connect
    from app.seed import create_demo_case
    with connect() as c:
        create_demo_case(c, first_name="María")
    at = page("demo").run()
    def dis(label):
        return next(b.disabled for b in at.button if label in b.label)
    assert dis("Abrir expediente") is False
    for later in ("Ejecutar análisis", "Mostrar control", "Aprobar como revisor humano", "Simular respuesta y reanalizar", "Confirmar pago completo"):
        assert dis(later) is True, later


def test_used_maria_case_requires_a_new_one_and_keeps_old_data(seeded):
    from app.db import connect
    from app.seed import create_demo_case
    with connect() as c:
        old = create_demo_case(c, first_name="María")
    from app.events import EventIn, process_event
    with connect() as c:
        process_event(c, EventIn(event_id="used-1", event_type="INVESTIGATE", customer_id=old, source="system", payload={}))
    at = page("demo").run()
    assert "Este caso de María ya se usó" in texts(at)
    assert not [b for b in at.button if "Abrir expediente" in b.label]
    at.checkbox[0].check().run()
    click(at, "Crear caso nuevo de María")
    ids = [r[0] for r in q(seeded, "select customer_id from customers where first_name='María'")]
    assert len(ids) == 2 and old in ids
    assert q(seeded, f"select count(*) from events where customer_id='{old}'") == [(1,)]


def test_evidence_uses_business_labels_not_field_paths(seeded):
    at = page("cliente360").run()
    click(at, "Ejecutar análisis")
    t = texts(at)
    assert "Pagos omitidos (6 meses)" in t and "behavior." not in t and "account." not in t
