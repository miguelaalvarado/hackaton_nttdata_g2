"""Demo guiada y mapa: recorren el caso completo con clics reales y verifican la BD y el etiquetado honesto de motores."""
import json
import sqlite3
from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest

D = Path(__file__).resolve().parent.parent / "dashboard"


def test_guided_demo_runs_full_case(isolated_db):
    at = AppTest.from_file(str(D / "pages" / "1_Demo_guiada.py"), default_timeout=60).run()
    at.sidebar.button[[b.label for b in at.sidebar.button].index(next(l for l in [b.label for b in at.sidebar.button] if "Nuevo caso" in l))].click().run()
    assert not at.exception
    q = lambda sql: sqlite3.connect(isolated_db).execute(sql).fetchall()
    cid = q("select customer_id from customers")[0][0]
    for label in ("Evaluar caso", "Aprobar como humano", "Ejecutar contacto", "Programar seguimiento", "Simular pago completo"):
        btn = [b for b in at.button if label in b.label]
        assert btn and not btn[0].disabled, f"{label} no disponible en orden"
        btn[0].click(); at.run()
        assert not at.exception, (label, at.exception)
    assert q("select review_status from decisions order by created_at") == [("approved",), ("pending",)]
    assert q("select validity from decisions order by created_at") == [("valid",), ("stale",)]
    assert q("select outcome from contact_history") == [("SIMULATED_SENT",)]
    assert q(f"select status from installments where customer_id='{cid}' and sequence=1") == [("PAID",)]
    assert q(f"select outstanding_cents from loans where customer_id='{cid}'") == [(800000 - 65000,)]
    assert q("select count(*) from scheduled_actions where installment_id like '%-1' and status in ('PENDING','DUE','BLOCKED')") == [(0,)]


def test_component_map_labels_engines_honestly(isolated_db, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from app.db import connect
    from app.orchestrator import propose_case
    from app.seed import seed_demo
    with connect() as c:
        seed_demo(c)
    propose_case("CLI-0003")
    at = AppTest.from_file(str(D / "pages" / "2_Mapa_de_componentes.py"), default_timeout=60).run()
    assert not at.exception
    assert any("Ninguna corrida usa IA generativa" in w.value for w in at.warning)
    assert q_engines(isolated_db) == {"rules"}


def q_engines(db):
    con = sqlite3.connect(db)
    return {json.loads(o)["engine"] for (o,) in con.execute("select output_json from agent_runs where agent_name in "
            "('risk_agent','strategy_agent','contact_agent','conversational_agent','negotiation_agent','compliance_agent')")}
