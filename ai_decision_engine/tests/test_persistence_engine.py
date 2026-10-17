"""P0/P1: persistencia, eventos idempotentes, pagos, promesas, exclusión, disputa, agenda y versionado."""
import copy
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from app import scheduling
from app.db import connect, transaction
from app.events import EventIn, EventRejected, process_event
from app.repositories import ActionRepo, AgentRunRepo, ContactRepo, CustomerRepo, DecisionRepo, InstallmentRepo, LoanRepo, PaymentRepo, PromiseRepo
from app.seed import seed_demo
from tests.conftest import BASE, as_role
from tests.test_agent_proposals import _payload

UTC = timezone.utc
# Lunes 2026-10-19 15:00 UTC = 10:00 Lima (día hábil, dentro de ventana)
T0 = datetime(2026, 10, 19, 15, 0, tzinfo=UTC)
_n = 0


_SRC = {"PAYMENT_POSTED": "bank_simulator", "PAYMENT_PENDING": "bank_simulator", "PAYMENT_REVERSED": "bank_simulator",
        "HUMAN_REVIEW": "human"}


def ev(event_type, customer_id="CLI-0002", source=None, at=None, installment_id=None, **payload):
    global _n
    _n += 1
    source = source or _SRC.get(event_type, "system")
    return EventIn(event_id=payload.pop("event_id", f"e-{_n}"), event_type=event_type, customer_id=customer_id,
                   installment_id=installment_id, source=source, occurred_at=at or T0, payload=payload)


def pay(ref, cents, customer_id="CLI-0002", inst=None, at=None, **kw):
    inst = inst or f"IN-{customer_id[-4:]}-1"
    kw.setdefault("currency", "PEN")
    return ev("PAYMENT_POSTED", customer_id, "bank_simulator", at, inst, payment_ref=ref, amount_cents=cents, **kw)


@pytest.fixture()
def conn(isolated_db):
    with connect() as c:
        seed_demo(c, T0)
        yield c


def inst(conn, iid="IN-0002-1"):
    return InstallmentRepo(conn).get(iid)


def test_database_persists_after_restart(isolated_db):
    with connect() as c:
        seed_demo(c, T0)
        process_event(c, pay("P1", 30000))
    # "reinicio": conexión nueva + caché de esquema vaciado
    from app import db as dbm
    dbm._initialized.clear()
    with connect() as c2:
        assert inst(c2)["paid_cents"] == 30000
        assert LoanRepo(c2).get("LN-0002")["outstanding_cents"] == 12000_00 - 30000
        assert c2.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= 1
        assert ActionRepo(c2).active_for_customer("CLI-0002")


def test_decisions_and_review_persist_across_restart(client, isolated_db):
    d = client.post("/v1/agent-proposals/evaluate", json=_payload()).json()
    client.post(f"/v1/decisions/{d['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human"))
    from app import db as dbm
    dbm._initialized.clear()
    got = client.get(f"/v1/decisions/{d['decision_id']}").json()
    assert got["review_status"] == "approved" and got["case_version"] == 1


def test_confirmed_payment_updates_balance(conn):
    r = process_event(conn, pay("P1", 80000))
    i = inst(conn)
    assert i["paid_cents"] == 80000 and i["status"] == "PAID"
    assert LoanRepo(conn).get("LN-0002")["outstanding_cents"] == 12000_00 - 80000
    assert r["case_version"] == 2


def test_payment_requires_bank_simulator(conn):
    with pytest.raises(EventRejected) as e:
        process_event(conn, ev("PAYMENT_POSTED", source="agent", installment_id="IN-0002-1", payment_ref="X", amount_cents=100))
    assert e.value.status == 403 and inst(conn)["paid_cents"] == 0
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0  # denegación de autorización: cero escrituras


def test_duplicate_payment_not_double_counted(conn):
    process_event(conn, pay("P1", 30000, event_id="evt-A"))
    same_event = process_event(conn, pay("P1", 30000, event_id="evt-A"))
    assert same_event["idempotent_replay"] is True
    other_event_same_ref = process_event(conn, pay("P1", 30000, event_id="evt-B"))
    assert other_event_same_ref["status"] == "DUPLICATE"
    assert inst(conn)["paid_cents"] == 30000
    assert conn.execute("SELECT COUNT(*) FROM payments WHERE kind='PAYMENT'").fetchone()[0] == 1
    assert CustomerRepo(conn).get("CLI-0002")["case_version"] == 2  # una sola vez


def test_payment_validation(conn):
    for bad in (pay("P9", 10, currency="USD"), pay("P9", 999999999), pay("P9", 100, inst="IN-0001-1"), pay("P9", -5),
                ev("PAYMENT_POSTED", "NOPE", "bank_simulator", installment_id="IN-0002-1", payment_ref="P9", amount_cents=1)):
        with pytest.raises(EventRejected):
            process_event(conn, bad)
    assert inst(conn)["paid_cents"] == 0


def test_partial_payment_keeps_correct_remaining(conn):
    process_event(conn, pay("P1", 30000))
    process_event(conn, pay("P2", 12345))
    i = inst(conn)
    assert i["paid_cents"] == 42345 and i["status"] == "PARTIAL"
    assert i["amount_cents"] - i["paid_cents"] == 37655
    assert ActionRepo(conn).active_for_customer("CLI-0002")  # sigue gestionándose


def test_full_payment_cancels_actions_of_that_installment(conn):
    before = [a for a in ActionRepo(conn).active_for_customer("CLI-0002") if a["installment_id"] == "IN-0002-1"]
    assert before
    r = process_event(conn, pay("PF", 80000))
    assert inst(conn)["status"] == "PAID" and inst(conn)["closed_at"]
    for a in before:
        assert ActionRepo(conn).get(a["action_id"])["status"] == "CANCELLED"
    assert not [a for a in ActionRepo(conn).active_for_customer("CLI-0002") if a["installment_id"] == "IN-0002-1"]


def test_pending_payment_not_deducted_and_blocks_actions(conn):
    process_event(conn, ev("PAYMENT_PENDING", installment_id="IN-0002-1", payment_ref="PP", amount_cents=80000, currency="PEN"))
    assert inst(conn)["paid_cents"] == 0
    assert LoanRepo(conn).get("LN-0002")["outstanding_cents"] == 12000_00
    assert not [a for a in ActionRepo(conn).active_for_customer("CLI-0002") if a["status"] in ("PENDING", "DUE")]
    # confirmar el pendiente lo convierte en pago real, una sola vez
    process_event(conn, pay("PP", 80000))
    assert inst(conn)["paid_cents"] == 80000
    assert conn.execute("SELECT COUNT(*) FROM payments WHERE payment_ref='PP'").fetchone()[0] == 1


def test_payment_reversal_is_compensating_and_reevaluates(conn):
    process_event(conn, pay("P1", 80000))
    assert inst(conn)["status"] == "PAID"
    process_event(conn, ev("PAYMENT_REVERSED", payment_ref="P1"))
    i = inst(conn)
    assert i["paid_cents"] == 0 and i["status"] == "OPEN" and i["closed_at"] is None
    assert LoanRepo(conn).get("LN-0002")["outstanding_cents"] == 12000_00
    assert conn.execute("SELECT COUNT(*) FROM payments WHERE kind='REVERSAL' AND reverses_payment_id IS NOT NULL").fetchone()[0] == 1
    assert CustomerRepo(conn).get("CLI-0002")["needs_reevaluation"] == 1
    assert ActionRepo(conn).active_for_customer("CLI-0002")  # vuelve a existir gestión
    process_event(conn, ev("PAYMENT_REVERSED", payment_ref="P1", event_id="again"))  # idempotente
    assert inst(conn)["paid_cents"] == 0


def test_promise_is_not_a_payment(conn):
    process_event(conn, ev("PROMISE_CREATED", installment_id="IN-0002-1", amount_cents=50000, promised_date="2026-10-25"))
    assert inst(conn)["paid_cents"] == 0
    assert LoanRepo(conn).get("LN-0002")["outstanding_cents"] == 12000_00
    p = PromiseRepo(conn).for_customer("CLI-0002")[0]
    assert p["status"] == "OPEN" and p["promised_amount_cents"] == 50000 and p["promised_date"] == "2026-10-25"
    assert PaymentRepo(conn).for_customer("CLI-0002") == []
    # el motor no contacta antes de la fecha prometida
    a = ActionRepo(conn).active_for_customer("CLI-0002")[0]
    assert a["action_type"] == "PROMISE_FOLLOWUP" and a["scheduled_at"] >= "2026-10-26"
    # promesa incumplida
    process_event(conn, ev("PROMISE_DUE", at=T0 + timedelta(days=7), promise_id=p["promise_id"]))
    assert PromiseRepo(conn).get(p["promise_id"])["status"] == "BROKEN"
    assert CustomerRepo(conn).get("CLI-0002")["needs_reevaluation"] == 1


def test_promise_kept_when_paid(conn):
    process_event(conn, ev("PROMISE_CREATED", installment_id="IN-0002-1", amount_cents=30000, promised_date="2026-10-25"))
    p = PromiseRepo(conn).for_customer("CLI-0002")[0]
    process_event(conn, pay("P1", 30000, at=T0 + timedelta(days=1)))
    assert PromiseRepo(conn).get(p["promise_id"])["status"] == "KEPT"


def test_scheduler_respects_frequency_rules(conn):
    policy = scheduling.load_policy(conn)
    assert policy.min_hours_between_contacts == 48
    process_event(conn, ev("CONTACT_RECORDED", channel="whatsapp", outcome="DELIVERED", at=T0))
    a = ActionRepo(conn).active_for_customer("CLI-0002")[0]
    assert a["scheduled_at"] >= (T0 + timedelta(hours=48)).isoformat()
    assert "Intervalo mínimo 48h" in a["reason"]
    # política configurable y auditable
    with transaction(conn):
        scheduling.save_policy(conn, T0, {"min_hours_between_contacts": 24}, "tester")
    assert conn.execute("SELECT updated_by FROM policy_config WHERE key='min_hours_between_contacts'").fetchone()[0] == "tester"
    scheduling.reevaluate_customer(conn, "CLI-0002", T0, "TEST")
    a2 = ActionRepo(conn).active_for_customer("CLI-0002")[0]
    assert a2["scheduled_at"] < a["scheduled_at"] and a2["scheduled_at"] >= (T0 + timedelta(hours=24)).isoformat()
    assert '"min_hours_between_contacts": 24' in a2["policy_json"]


def test_scheduler_weekly_cap(conn):
    with transaction(conn):
        scheduling.save_policy(conn, T0, {"min_hours_between_contacts": 0, "max_contacts_per_7d": 2}, "t")
    for i in range(2):
        process_event(conn, ev("CONTACT_RECORDED", channel="sms", outcome="DELIVERED", at=T0 + timedelta(minutes=i)))
    a = ActionRepo(conn).active_for_customer("CLI-0002")[0]
    assert a["scheduled_at"] >= (T0 + timedelta(days=7)).isoformat()


def test_opt_out_blocks_affected_actions(conn):
    chans = {a["channel"] for a in ActionRepo(conn).active_for_customer("CLI-0002")}
    ch = next(iter(chans))
    process_event(conn, ev("CONTACT_OPT_OUT", channels=[ch]))
    for a in ActionRepo(conn).active_for_customer("CLI-0002"):
        assert a["channel"] != ch
    process_event(conn, ev("CONTACT_OPT_OUT", all=True))
    assert ActionRepo(conn).active_for_customer("CLI-0002") == []
    assert CustomerRepo(conn).get("CLI-0002")["opted_out_all"] == 1


def test_reply_with_baja_triggers_opt_out(conn):
    process_event(conn, ev("CUSTOMER_REPLIED", text="Por favor BAJA", channel="whatsapp"))
    assert "whatsapp" in CustomerRepo(conn).get("CLI-0002")["opted_out_channels"]
    assert all(a["channel"] != "whatsapp" for a in ActionRepo(conn).active_for_customer("CLI-0002"))


def test_dispute_suspends_incompatible_actions(conn):
    process_event(conn, ev("DISPUTE_OPENED", reason="Cobro no reconocido"))
    acts = ActionRepo(conn).for_customer("CLI-0002")
    live = [a for a in acts if a["status"] in ("PENDING", "DUE")]
    assert [a["action_type"] for a in live] == ["HUMAN_REVIEW"]
    assert any(a["status"] == "BLOCKED" for a in acts)
    # resolución humana reactiva la gestión
    process_event(conn, ev("HUMAN_REVIEW", source="human", kind="resolve_dispute", reviewer_id="ana"))
    live = [a for a in ActionRepo(conn).active_for_customer("CLI-0002") if a["status"] in ("PENDING", "DUE")]
    assert live and live[0]["action_type"] != "HUMAN_REVIEW"


def _proposal(customer_id="CLI-0002"):
    p = _payload()
    p["context"]["customer"]["customer_id"] = customer_id
    return p


def test_stale_case_version_decision_cannot_be_approved(client, conn):
    p = _proposal()
    d = client.post("/v1/agent-proposals/evaluate", json=p).json()
    assert d["case_version"] == 1 and d["validity"] == "valid"
    process_event(conn, pay("P1", 30000))  # cambia el expediente
    r = client.post(f"/v1/decisions/{d['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "STALE_CASE_VERSION"
    assert client.get(f"/v1/decisions/{d['decision_id']}").json()["validity"] == "stale"
    # tras reevaluar con la versión vigente sí se puede aprobar
    p2 = _proposal(); p2["proposal_id"] = "prop-2"; p2["context"]["case_version"] = 2
    d2 = client.post("/v1/agent-proposals/evaluate", json=p2).json()
    ok = client.post(f"/v1/decisions/{d2['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human"))
    assert ok.status_code == 200
    # una decisión creada con versión vieja nace obsoleta
    p3 = _proposal(); p3["proposal_id"] = "prop-3"; p3["context"]["case_version"] = 1
    d3 = client.post("/v1/agent-proposals/evaluate", json=p3).json()
    assert d3["validity"] == "stale"
    assert client.post(f"/v1/decisions/{d3['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human")).status_code == 409


def test_approval_blocked_by_dispute_and_pending_payment(client, conn):
    d = client.post("/v1/agent-proposals/evaluate", json=_proposal()).json()
    process_event(conn, ev("PAYMENT_PENDING", installment_id="IN-0002-1", payment_ref="PP", amount_cents=100, currency="PEN"))
    p2 = _proposal(); p2["proposal_id"] = "p2"; p2["context"]["case_version"] = CustomerRepo(conn).get("CLI-0002")["case_version"]
    d2 = client.post("/v1/agent-proposals/evaluate", json=p2).json()
    r = client.post(f"/v1/decisions/{d2['decision_id']}/review", json={"reviewer_id": "h", "action": "approve"}, headers=as_role(client, "human"))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "PAYMENT_PENDING"


def test_scheduled_action_is_revalidated_before_execution(conn):
    a = ActionRepo(conn).active_for_customer("CLI-0003")[0]  # cuota vencida: acción inmediata
    when = datetime.fromisoformat(a["scheduled_at"])
    # cambia el estado después de programar: el cliente se excluye del canal de la acción
    process_event(conn, ev("CONTACT_OPT_OUT", "CLI-0003", channels=[a["channel"]], at=when))
    res = scheduling.execute_action(conn, a["action_id"], when)
    assert res["executed"] is False and res["outcome"] == "NOT_EXECUTABLE"
    # acción vigente: se revalida contra el case_version actual y se ejecuta en modo simulado
    b = ActionRepo(conn).active_for_customer("CLI-0003")[0]
    when_b = datetime.fromisoformat(b["scheduled_at"])
    process_event(conn, ev("INVESTIGATE", "CLI-0003", at=when_b))  # sin cambio de versión
    with transaction(conn):
        CustomerRepo(conn).bump_version(when_b, "CLI-0003")  # el expediente cambió: la acción quedó con versión vieja
    res = scheduling.execute_action(conn, b["action_id"], when_b)
    assert res["executed"] is True and res["sent_real_message"] is False
    assert res["revalidated_against_case_version"] == 3
    assert ActionRepo(conn).get(b["action_id"])["case_version"] == 3
    assert ActionRepo(conn).get(b["action_id"])["status"] == "COMPLETED"
    c = ContactRepo(conn).last_outbound("CLI-0003")
    assert c["outcome"] == "SIMULATED_SENT" and c["action_id"] == b["action_id"]
    # el siguiente contacto respeta el intervalo mínimo
    nxt = ActionRepo(conn).active_for_customer("CLI-0003")[0]
    assert nxt["scheduled_at"] >= (when_b + timedelta(hours=48)).isoformat()


def test_execution_before_due_time_is_refused(conn):
    a = ActionRepo(conn).active_for_customer("CLI-0001")[0]  # recordatorio programado a futuro
    res = scheduling.execute_action(conn, a["action_id"], T0)
    assert res["executed"] is False and res["outcome"] == "NOT_YET_DUE"


def test_tick_marks_due_and_expires(conn):
    a = ActionRepo(conn).active_for_customer("CLI-0003")[0]
    when = datetime.fromisoformat(a["scheduled_at"])
    r = scheduling.tick(conn, when + timedelta(minutes=1))
    assert a["action_id"] in r["marked_due"] and ActionRepo(conn).get(a["action_id"])["status"] == "DUE"
    r = scheduling.tick(conn, when + timedelta(hours=30))
    assert a["action_id"] in r["expired"] and ActionRepo(conn).get(a["action_id"])["status"] == "EXPIRED"
    assert ActionRepo(conn).active_for_customer("CLI-0003")  # reprogramada


def test_decisions_events_and_agent_runs_are_recorded(client, conn):
    d = client.post("/v1/agent-proposals/evaluate", json=_proposal()).json()
    runs = AgentRunRepo(conn).list("CLI-0002")
    assert any(r["decision_id"] == d["decision_id"] and r["agent_name"] == "agente-x" for r in runs)
    assert any(r["agent_name"] == "followup_learning" for r in runs)
    row = DecisionRepo(conn).get(d["decision_id"])
    assert row["case_version"] == 1 and row["agent_id"] == "agente-x" and row["review_status"] == "pending"
    process_event(conn, pay("P1", 1000))
    ev_row = conn.execute("SELECT trace_json, case_version_after FROM events WHERE event_type='PAYMENT_POSTED'").fetchone()
    assert "payment_recorded" in ev_row["trace_json"] and "decisions_invalidated" in ev_row["trace_json"]
    assert ev_row["case_version_after"] == 2


def test_event_api_end_to_end(client, isolated_db):
    client.post("/v1/dev/seed", headers=as_role(client, "system"))
    H = as_role(client, "bank_simulator")
    body = {"event_id": "api-1", "event_type": "PAYMENT_POSTED", "customer_id": "CLI-0002",
            "installment_id": "IN-0002-1", "payload": {"payment_ref": "API-P", "amount": "100.10", "currency": "PEN"}}
    r = client.post("/v1/events", json=body, headers=H)
    assert r.status_code == 200 and r.json()["status"] == "PROCESSED"
    assert client.post("/v1/events", json=body, headers=H).json()["idempotent_replay"] is True
    st = client.get("/v1/customers/CLI-0002").json()
    assert st["installments"][0]["paid_cents"] == 10010
    assert client.get("/v1/customers/needs-reevaluation").status_code == 200


def test_money_never_float(conn):
    process_event(conn, pay("PM", 1234))
    from app.db import to_cents
    assert to_cents("0.1") + to_cents("0.2") == to_cents("0.3") == 30
    with pytest.raises(ValueError):
        to_cents("1.005")
    for tbl, col in (("installments", "amount_cents"), ("payments", "amount_cents"), ("loans", "outstanding_cents")):
        assert conn.execute(f"SELECT typeof({col}) FROM {tbl} LIMIT 1").fetchone()[0] in ("integer",)
