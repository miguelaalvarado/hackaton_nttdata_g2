import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    return TestClient(app)


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
