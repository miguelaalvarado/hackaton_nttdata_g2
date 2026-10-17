import copy
import json
import secrets

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    """Cada prueba usa su propia base SQLite temporal."""
    monkeypatch.setenv("NEXO_DB_PATH", str(tmp_path / "test.db"))
    return tmp_path / "test.db"


@pytest.fixture(autouse=True)
def integration_keys(monkeypatch):
    """Claves de prueba aleatorias por ejecución (nunca fijas en el repo). Un rol = una clave."""
    from app.auth import ROLES
    keys = {role: "test-" + secrets.token_hex(16) for role in sorted(ROLES)}
    monkeypatch.setenv("NEXO_INTEGRATION_KEYS", json.dumps({k: r for r, k in keys.items()}))
    monkeypatch.setenv("NEXO_ENABLE_DEV_SEED", "1")
    # Las pruebas nunca leen .env ni usan claves de proveedores reales
    monkeypatch.setenv("NEXO_DISABLE_DOTENV", "1")
    for var in ("LLM_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return keys


@pytest.fixture()
def client(integration_keys):
    """Cliente HTTP con credencial de rol `agent` por defecto (puede proponer y leer, no revisar ni pagar)."""
    c = TestClient(app, headers={"X-Integration-Key": integration_keys["agent"]})
    c.keys = integration_keys
    return c


def as_role(client, role):
    return {"X-Integration-Key": client.keys[role]}


BASE = {
    "request_id": "req-001",
    "customer": {
        "customer_id": "CLI-0001", "first_name": "Lucía", "language": "es",
        "contact_consent": ["sms", "email", "whatsapp", "push", "phone_call"],
        "preferred_channel": None,
    },
    "account": {
        "product": "credit_card", "currency": "PEN", "installment_amount": 450.0,
        "next_due_date": "2026-11-05", "days_past_due": 0, "outstanding_balance": 5200.0,
    },
    "behavior": {
        "missed_payments_last_6m": 0, "on_time_payment_ratio_6m": 1.0,
        "credit_utilization": 0.25, "payment_trend": "stable",
    },
    "risk_score": {"value": 12, "model_version": "ext-risk-v3", "scored_at": "2026-10-16"},
    "local_hour": 10,
}


@pytest.fixture()
def make_request():
    def _make(**overrides):
        data = copy.deepcopy(BASE)
        for path, value in overrides.items():
            node = data
            *parents, leaf = path.split(".")
            for p in parents:
                node = node[p]
            node[leaf] = value
        return data
    return _make
