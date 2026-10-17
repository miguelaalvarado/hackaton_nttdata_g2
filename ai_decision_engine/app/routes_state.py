"""API del estado persistido: eventos, clientes, agenda de acciones y política de seguimiento."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from . import scheduling
from .auth import OPERATE_ROLES, PROPOSE_ROLES, READ_ROLES, ROLES, event_allowed, require_roles
from .db import connect, transaction, utcnow
from .events import EventIn, EventRejected, process_event
from .repositories import ActionRepo, AgentRunRepo, CustomerRepo
from .state_views import customer_state, list_customers

router = APIRouter(prefix="/v1", tags=["estado-y-seguimiento"])
_read = [Depends(require_roles(READ_ROLES))]
_operate = [Depends(require_roles(OPERATE_ROLES))]


class NowBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    now: datetime | None = None


@router.post("/events")
def post_event(ev: EventIn, role: str = Depends(require_roles(set(ROLES)))):
    """Procesa un evento (idempotente por event_id). El origen sale de la credencial, nunca del cuerpo.

    Si el cuerpo declara un `source` distinto al de la credencial, o el rol no puede registrar ese tipo de evento,
    se responde 403 sin escribir en la BD.
    """
    if ev.source is not None and ev.source != role:
        raise HTTPException(403, {"code": "SOURCE_MISMATCH",
                                  "message": "El 'source' declarado no coincide con la credencial presentada"})
    ev.source = role
    if not event_allowed(ev.event_type.value, role):
        raise HTTPException(403, {"code": "FORBIDDEN_ROLE",
                                  "message": f"El rol '{role}' no puede registrar {ev.event_type.value}"})
    with connect() as conn:
        try:
            res = process_event(conn, ev)
        except EventRejected as rej:
            raise HTTPException(rej.status, {"code": "EVENT_REJECTED", "message": rej.reason, "event_id": ev.event_id})
    if res["status"] == "REJECTED":
        raise HTTPException(422, {"code": "EVENT_REJECTED", "message": res["reason"], "event_id": ev.event_id,
                                  "idempotent_replay": True})
    return res


@router.get("/customers", dependencies=_read)
def customers():
    with connect() as conn:
        return list_customers(conn)


@router.get("/customers/needs-reevaluation", dependencies=_read)
def needs_reevaluation():
    with connect() as conn:
        return [{"customer_id": c["customer_id"], "case_version": c["case_version"], "reason": c["reevaluation_reason"]}
                for c in CustomerRepo(conn).needing_reevaluation()]


@router.get("/customers/{customer_id}", dependencies=_read)
def customer(customer_id: str):
    with connect() as conn:
        st = customer_state(conn, customer_id)
    if st is None:
        raise HTTPException(404, "Cliente no encontrado")
    return st


@router.post("/customers/{customer_id}/reevaluate", dependencies=_operate)
def reevaluate(customer_id: str, body: NowBody | None = None):
    with connect() as conn:
        if CustomerRepo(conn).get(customer_id) is None:
            raise HTTPException(404, "Cliente no encontrado")
        with transaction(conn):
            return scheduling.reevaluate_customer(conn, customer_id, (body and body.now) or utcnow(), "MANUAL")


@router.get("/scheduled-actions", dependencies=_read)
def scheduled_actions(status: str | None = None, customer_id: str | None = None):
    with connect() as conn:
        return ActionRepo(conn).list(status, customer_id)


@router.post("/scheduled-actions/{action_id}/execute", dependencies=_operate)
def execute_action(action_id: str, body: NowBody | None = None):
    """Ejecución SIMULADA con revalidación. Nunca envía mensajes reales."""
    with connect() as conn:
        with transaction(conn):
            try:
                return scheduling.execute_action(conn, action_id, (body and body.now) or utcnow())
            except LookupError:
                raise HTTPException(404, "Acción no encontrada")


@router.post("/scheduler/tick", dependencies=_operate)
def scheduler_tick(body: NowBody | None = None):
    with connect() as conn:
        with transaction(conn):
            return scheduling.tick(conn, (body and body.now) or utcnow())


@router.get("/policy", dependencies=_read)
def get_policy():
    with connect() as conn:
        return scheduling.load_policy(conn).snapshot()


@router.put("/policy", dependencies=_operate)
def put_policy(changes: dict, updated_by: str = "api"):
    with connect() as conn:
        try:
            with transaction(conn):
                return scheduling.save_policy(conn, utcnow(), changes, updated_by).snapshot()
        except ValueError as exc:
            raise HTTPException(422, str(exc))


@router.get("/agent-runs", dependencies=_read)
def agent_runs(customer_id: str | None = None, limit: int = 100):
    import json
    with connect() as conn:
        rows = AgentRunRepo(conn).list(customer_id, limit)
    for r in rows:
        r["input"] = json.loads(r.pop("input_json")); r["output"] = json.loads(r.pop("output_json"))
    return rows


@router.post("/dev/seed", tags=["demo"], dependencies=_operate)
def dev_seed():
    """Carga clientes ficticios de demostración (idempotente)."""
    import os
    if os.getenv("NEXO_ENABLE_DEV_SEED") != "1":  # desactivado por defecto: no publicar datos demo por HTTP
        raise HTTPException(404, "No encontrado")
    from .seed import seed_demo
    with connect() as conn:
        return seed_demo(conn)


class RunBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_id: str
    now: datetime | None = None


@router.post("/orchestrator/run", dependencies=[Depends(require_roles(PROPOSE_ROLES))])
def orchestrator_run(body: RunBody):
    """Orquestador: consulta BD → riesgo → estrategia → contacto → mensaje → negociación → validación del Decision Engine.
    Deja una decisión PENDIENTE de aprobación humana; no envía nada."""
    from .orchestrator import propose_case
    try:
        return propose_case(body.customer_id, body.now)
    except LookupError as exc:
        raise HTTPException(404, str(exc))


@router.post("/orchestrator/followup/{customer_id}", dependencies=[Depends(require_roles(OPERATE_ROLES))])
def orchestrator_followup(customer_id: str, body: NowBody | None = None):
    """Agente 7: reevalúa y devuelve la próxima fecha de seguimiento."""
    from .orchestrator import followup_agent
    with connect() as conn:
        if CustomerRepo(conn).get(customer_id) is None:
            raise HTTPException(404, "Cliente no encontrado")
    return followup_agent(customer_id, body.now if body else None)
