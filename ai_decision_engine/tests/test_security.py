"""Frontera HTTP: autenticación por clave de integración, roles, fail-closed y cero escrituras ante una denegación."""
import copy
import logging
import sqlite3

import pytest

from app.auth import EVENT_PERMISSIONS
from tests.conftest import as_role
from tests.test_agent_proposals import _payload

ALL_TABLES = ("customers", "loans", "installments", "payments", "contact_history", "conversations", "promises",
              "decisions", "scheduled_actions", "events", "agent_runs", "policy_config")


@pytest.fixture()
def seeded(client, isolated_db):
    assert client.post("/v1/dev/seed", headers=as_role(client, "system")).status_code == 200
    return client


def snapshot(db):
    con = sqlite3.connect(db)
    return {t: con.execute(f"SELECT COUNT(*), COALESCE(MAX(updated_at),'') FROM {t}").fetchone() if t not in ("events", "agent_runs", "contact_history", "conversations")
            else con.execute(f"SELECT COUNT(*), 0 FROM {t}").fetchone() for t in ALL_TABLES} | {
        "installments_paid": con.execute("SELECT SUM(paid_cents) FROM installments").fetchone(),
        "decision_status": con.execute("SELECT GROUP_CONCAT(review_status||validity) FROM decisions").fetchone()}


def pay_body(event_id="s-1", ref="SEC-1", cents=1000, **extra):
    return {"event_id": event_id, "event_type": "PAYMENT_POSTED", "customer_id": "CLI-0002", "installment_id": "IN-0002-1",
            "payload": {"payment_ref": ref, "amount_cents": cents, "currency": "PEN"}} | extra


def proposal(seeded, pid="p1", version=None):
    p = copy.deepcopy(_payload()); p["proposal_id"] = pid; p["context"]["customer"]["customer_id"] = "CLI-0002"
    if version:
        p["context"]["case_version"] = version
    r = seeded.post("/v1/agent-proposals/evaluate", json=p)
    assert r.status_code == 201, r.text
    return r.json()


def review(c, did, role="human", action="approve", key=None):
    h = {"X-Integration-Key": key} if key else ({} if role is None else as_role(c, role))
    return c.post(f"/v1/decisions/{did}/review", json={"reviewer_id": "rev-1", "action": action}, headers=h)


# ----------------------------------------------------- review: autenticación y rol
@pytest.mark.parametrize("role", ["agent", "system", "reader", "bank_simulator", "customer_channel"])
def test_non_human_roles_cannot_approve_or_reject(seeded, isolated_db, role):
    d = proposal(seeded)
    before = snapshot(isolated_db)
    for action in ("approve", "reject"):
        assert review(seeded, d["decision_id"], role, action).status_code == 403
    assert snapshot(isolated_db) == before


@pytest.mark.parametrize("key", [None, "", "clave-incorrecta", "TEST-" ])
def test_review_without_or_with_wrong_key_is_401_and_changes_nothing(seeded, isolated_db, key):
    d = proposal(seeded)
    before = snapshot(isolated_db)
    anon = type(seeded)(seeded.app)  # sin cabecera por defecto
    r = anon.post(f"/v1/decisions/{d['decision_id']}/review", json={"reviewer_id": "x", "action": "approve"},
                  headers={"X-Integration-Key": key} if key is not None else {})
    assert r.status_code == 401 and r.json()["detail"]["code"] == "UNAUTHENTICATED"
    assert snapshot(isolated_db) == before
    assert seeded.get(f"/v1/decisions/{d['decision_id']}").json()["review_status"] == "pending"


def test_fail_closed_when_no_keys_configured(seeded, monkeypatch, isolated_db):
    d = proposal(seeded)
    monkeypatch.delenv("NEXO_INTEGRATION_KEYS")
    monkeypatch.setenv("NEXO_INTEGRATION_KEYS", "esto no es json")
    for role in ("human", "agent", "bank_simulator"):
        assert review(seeded, d["decision_id"], role).status_code == 401
    assert seeded.post("/v1/events", json=pay_body(), headers=as_role(seeded, "bank_simulator")).status_code == 401


def test_human_can_review_and_duplicate_approval_is_rejected(seeded):
    d = proposal(seeded)
    assert review(seeded, d["decision_id"]).status_code == 200
    again = review(seeded, d["decision_id"])
    assert again.status_code == 409 and "approved" in str(again.json()["detail"])
    assert review(seeded, d["decision_id"], action="reject").status_code == 409  # ya decidida: no se puede cambiar


def test_stale_decision_cannot_be_approved_direct_or_via_event(seeded, isolated_db):
    d = proposal(seeded)
    bank = as_role(seeded, "bank_simulator")
    assert seeded.post("/v1/events", json=pay_body(cents=1000), headers=bank).status_code == 200  # cambia case_version
    r = review(seeded, d["decision_id"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "STALE_CASE_VERSION"
    # misma validación por la ruta alternativa POST /v1/events
    ev = {"event_id": "hr-1", "event_type": "HUMAN_REVIEW", "customer_id": "CLI-0002",
          "payload": {"decision_id": d["decision_id"], "reviewer_id": "rev-1", "action": "approve"}}
    r2 = seeded.post("/v1/events", json=ev, headers=as_role(seeded, "human"))
    assert r2.status_code == 409 and "obsoleta" in r2.json()["detail"]["message"]
    assert seeded.get(f"/v1/decisions/{d['decision_id']}").json()["review_status"] == "pending"


def test_event_route_and_direct_route_share_the_same_review_rules(seeded):
    # cumplimiento bloqueado: ninguna de las dos rutas puede aprobar
    p = copy.deepcopy(_payload()); p["proposal_id"] = "bad"; p["context"]["customer"]["customer_id"] = "CLI-0002"
    p["proposal"]["body"] = "Último aviso: embargo. Responde BAJA."
    blocked = seeded.post("/v1/agent-proposals/evaluate", json=p).json()
    assert blocked["compliance"]["status"] == "blocked_needs_rewrite"
    assert review(seeded, blocked["decision_id"]).status_code == 409
    ev = {"event_id": "hr-b", "event_type": "HUMAN_REVIEW", "customer_id": "CLI-0002",
          "payload": {"decision_id": blocked["decision_id"], "reviewer_id": "r", "action": "approve"}}
    assert seeded.post("/v1/events", json=ev, headers=as_role(seeded, "human")).status_code == 409
    # duplicado también por la ruta de eventos
    ok = proposal(seeded, "good")
    ev2 = ev | {"event_id": "hr-ok", "payload": {"decision_id": ok["decision_id"], "reviewer_id": "r", "action": "approve"}}
    assert seeded.post("/v1/events", json=ev2, headers=as_role(seeded, "human")).status_code == 200
    ev3 = ev2 | {"event_id": "hr-ok-2"}
    assert seeded.post("/v1/events", json=ev3, headers=as_role(seeded, "human")).status_code == 409
    assert review(seeded, ok["decision_id"]).status_code == 409


# ------------------------------------------------------- eventos: bypass de rol/origen
@pytest.mark.parametrize("role", ["agent", "system", "reader", "customer_channel", "human"])
def test_only_bank_simulator_can_register_payments(seeded, isolated_db, role):
    before = snapshot(isolated_db)
    for et in ("PAYMENT_POSTED", "PAYMENT_PENDING", "PAYMENT_REVERSED"):
        body = pay_body(event_id=f"x-{role}-{et}") | {"event_type": et}
        assert seeded.post("/v1/events", json=body, headers=as_role(seeded, role)).status_code == 403
    assert snapshot(isolated_db) == before


@pytest.mark.parametrize("role", ["agent", "system", "reader", "customer_channel", "bank_simulator"])
def test_only_human_can_register_human_review_events(seeded, isolated_db, role):
    d = proposal(seeded)
    before = snapshot(isolated_db)
    ev = {"event_id": f"hr-{role}", "event_type": "HUMAN_REVIEW", "customer_id": "CLI-0002",
          "payload": {"decision_id": d["decision_id"], "reviewer_id": "r", "action": "approve"}}
    assert seeded.post("/v1/events", json=ev, headers=as_role(seeded, role)).status_code == 403
    assert snapshot(isolated_db) == before


def test_untrusted_cannot_post_any_event_and_nothing_is_written(seeded, isolated_db):
    before = snapshot(isolated_db)
    anon = type(seeded)(seeded.app)
    for et in EVENT_PERMISSIONS:
        for headers in ({}, {"X-Integration-Key": "inventada"}):
            body = pay_body(event_id=f"u-{et}") | {"event_type": et}
            assert anon.post("/v1/events", json=body, headers=headers).status_code == 401
    assert snapshot(isolated_db) == before


def test_spoofed_source_in_body_is_rejected_without_writes(seeded, isolated_db):
    before = snapshot(isolated_db)
    for role in ("agent", "system", "reader", "customer_channel"):
        for fake in ("bank_simulator", "human"):
            r = seeded.post("/v1/events", json=pay_body(event_id=f"sp-{role}-{fake}", source=fake), headers=as_role(seeded, role))
            assert r.status_code == 403 and r.json()["detail"]["code"] == "SOURCE_MISMATCH"
    # sin credencial tampoco vale declarar el origen
    c2 = type(seeded)(seeded.app)
    assert c2.post("/v1/events", json=pay_body(source="bank_simulator")).status_code == 401
    assert snapshot(isolated_db) == before


def test_declared_source_matching_credential_is_fine(seeded):
    r = seeded.post("/v1/events", json=pay_body(source="bank_simulator"), headers=as_role(seeded, "bank_simulator"))
    assert r.status_code == 200


def test_valid_role_for_event_still_goes_through_business_validation(seeded):
    r = seeded.post("/v1/events", json=pay_body(cents=10**9), headers=as_role(seeded, "bank_simulator"))
    assert r.status_code == 422  # excede el saldo: autorizado, pero rechazado por negocio (y auditado)


def test_in_process_service_also_refuses_non_human_review(isolated_db):
    """Ruta alternativa: llamar al servicio directamente sin rol humano tampoco aprueba."""
    from app import decision_service
    from app.db import connect
    with connect() as c:
        with pytest.raises(decision_service.ReviewConflict) as e:
            decision_service.review_decision(c, "dec", "r", "approve", "", actor_role="agent")
        assert e.value.status == 403


# ------------------------------------------------------------- lectura / exposición
READ_ROUTES = ["/v1/customers", "/v1/customers/CLI-0002", "/v1/customers/needs-reevaluation", "/v1/scheduled-actions",
               "/v1/agent-runs", "/v1/policy"]


@pytest.mark.parametrize("path", READ_ROUTES)
def test_reads_require_credentials_and_leak_nothing(seeded, path):
    anon = type(seeded)(seeded.app)
    r = anon.get(path)
    assert r.status_code == 401 and "CLI-0002" not in r.text and "Carlos" not in r.text
    assert anon.get(path, headers={"X-Integration-Key": "mala"}).status_code == 401
    assert seeded.get(path, headers=as_role(seeded, "bank_simulator")).status_code == 403
    assert seeded.get(path, headers=as_role(seeded, "customer_channel")).status_code == 403
    assert seeded.get(path, headers=as_role(seeded, "reader")).status_code == 200


def test_decision_read_is_protected(seeded):
    d = proposal(seeded)
    anon = type(seeded)(seeded.app)
    assert anon.get(f"/v1/decisions/{d['decision_id']}").status_code == 401
    assert seeded.get(f"/v1/decisions/{d['decision_id']}", headers=as_role(seeded, "bank_simulator")).status_code == 403


def test_write_and_operate_routes_are_protected(seeded, isolated_db):
    anon = type(seeded)(seeded.app)
    before = snapshot(isolated_db)
    assert anon.post("/v1/agent-proposals/evaluate", json=_payload()).status_code == 401
    assert anon.post("/v1/dev/seed").status_code == 401
    assert anon.post("/v1/scheduler/tick").status_code == 401
    assert anon.put("/v1/policy", json={"max_contacts_per_7d": 99}).status_code == 401
    assert anon.post("/v1/customers/CLI-0002/reevaluate").status_code == 401
    assert anon.post("/v1/scheduled-actions/x/execute").status_code == 401
    for role in ("agent", "reader", "bank_simulator", "customer_channel"):  # operar la agenda exige human/system
        assert seeded.post("/v1/scheduler/tick", headers=as_role(seeded, role)).status_code == 403
        assert seeded.put("/v1/policy", json={"max_contacts_per_7d": 99}, headers=as_role(seeded, role)).status_code == 403
    assert snapshot(isolated_db) == before


def test_dev_seed_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("NEXO_ENABLE_DEV_SEED")
    assert client.post("/v1/dev/seed", headers=as_role(client, "system")).status_code == 404


def test_health_and_contract_are_public_and_expose_no_case_data(seeded):
    anon = type(seeded)(seeded.app)
    assert anon.get("/health").status_code == 200
    body = anon.get("/v1/contract").text
    assert "CLI-0002" not in body and "Carlos" not in body


# ---------------------------------------------------------------- secretos
def test_keys_never_leak_in_responses_or_logs(seeded, caplog, integration_keys):
    caplog.set_level(logging.DEBUG)
    bad = seeded.get("/v1/customers", headers={"X-Integration-Key": integration_keys["human"] + "x"})
    seeded.post("/v1/scheduler/tick", headers=as_role(seeded, "agent"))
    blob = bad.text + caplog.text
    assert all(k not in blob for k in integration_keys.values())
    assert integration_keys["human"] + "x" not in blob


def test_no_real_keys_in_repository_sources():
    import pathlib, re
    root = pathlib.Path(__file__).resolve().parent.parent
    pat = re.compile(r"NEXO_INTEGRATION_KEYS\s*=\s*['\"]?\{[^}]*\"[A-Za-z0-9_\-]{16,}\"\s*:")
    for f in list(root.glob("app/**/*.py")) + list(root.glob("dashboard/**/*.py")) + [root / "README.md"]:
        assert not pat.search(f.read_text()), f"posible clave en {f}"
