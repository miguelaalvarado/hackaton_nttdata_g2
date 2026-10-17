"""El dashboard no tiene botones decorativos: cada clic cambia (o consulta) la base SQLite real."""
import sqlite3
from pathlib import Path

import pytest

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest

APP = str(Path(__file__).resolve().parent.parent / "dashboard" / "streamlit_app.py")


def test_dashboard_buttons_mutate_real_database(isolated_db):
    at = AppTest.from_file(APP, default_timeout=60).run()
    assert not at.exception

    def click(label):
        btn = [b for b in at.button if label in b.label]
        assert btn, f"botón '{label}' no encontrado"
        btn[0].click(); at.run()
        assert not at.exception

    q = lambda sql: sqlite3.connect(isolated_db).execute(sql).fetchall()
    click("Cargar clientes demo")
    at.selectbox[0].select("CLI-0002").run()
    click("Pago parcial")
    assert q("select paid_cents, status from installments where installment_id='IN-0002-1'") == [(32000, "PARTIAL")]
    click("Pedir propuesta")
    assert q("select review_status, validity from decisions") == [("pending", "valid")]
    click("Compromiso de pago")
    assert q("select status from promises") == [("OPEN",)]
    assert q("select validity from decisions") == [("stale",)]  # el compromiso invalidó la propuesta previa
    click("Disputa")
    assert q("select dispute_open from customers where customer_id='CLI-0002'") == [(1,)]
    click("Exclusión voluntaria")
    assert q("select opted_out_all from customers where customer_id='CLI-0002'") == [(1,)]
    assert q("select count(*) from events where status='PROCESSED'")[0][0] >= 4
