"""API FastAPI del AI Decision Engine (MVP, solo datos ficticios, sin envíos reales)."""
from __future__ import annotations

import os
import uuid

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .auth import OPERATE_ROLES, PROPOSE_ROLES, READ_ROLES, REVIEW_ROLES, require_roles
from .calendar_pe import to_lima
from . import compliance, decision_service, interpreter, messages, strategy
from .db import connect
from .routes_state import router as state_router
from .schemas import (
    CONTRACT_VERSION, AgentInfo, AgentProposalRequest, DecisionRequest, DecisionResponse, DraftMessage,
    ReviewRequest, ReviewResponse, Strategy,
)

app = FastAPI(title="AI Decision Engine - Cobranza temprana", version=CONTRACT_VERSION,
              description="Módulo independiente. Genera borradores; nunca envía mensajes.")

# Orígenes del frontend (ej: "http://localhost:5173,http://localhost:3000")
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type", "X-Integration-Key"])

# Persistencia: SQLite (ver db.py). Las decisiones y su revisión humana sobreviven a reinicios.
app.include_router(state_router)


def _conflict(exc: decision_service.ReviewConflict) -> HTTPException:
    return HTTPException(exc.status, exc.detail if exc.detail.get("code") != "CONFLICT" else exc.message)


def _save(decision: DecisionResponse, req, agent_name: str, run_input: dict, notes: list[str] | None = None) -> DecisionResponse:
    with connect() as conn:
        if notes is None:
            notes = decision_service.reconciliation_notes(conn, req)
        else:
            notes = notes + decision_service.reconciliation_notes(conn, req)
        decision.alignment_notes = decision.alignment_notes + [n for n in notes if n not in decision.alignment_notes]
        try:
            return decision_service.save_decision(conn, decision, req, agent_name, run_input)
        except decision_service.ReviewConflict as exc:
            raise _conflict(exc)


@app.get("/health")
def health():
    return {"status": "ok", "contract_version": CONTRACT_VERSION, "sends_messages": False}


@app.get("/v1/contract")
def contract():
    return {"request": DecisionRequest.model_json_schema(), "response": DecisionResponse.model_json_schema(),
            "agent_proposal_request": AgentProposalRequest.model_json_schema()}


@app.post("/v1/decisions", response_model=DecisionResponse, status_code=201,
          dependencies=[Depends(require_roles(PROPOSE_ROLES))])
def create_decision(req: DecisionRequest) -> DecisionResponse:
    interp = interpreter.interpret(req)
    strat = strategy.select_strategy(req, interp)
    msg = messages.draft_message(req, strat)
    report = compliance.review(req, strat, msg)
    decision = DecisionResponse(
        decision_id=str(uuid.uuid4()), request_id=req.request_id, customer_id=req.customer.customer_id,
        interpretation=interp, strategy=strat, message=msg, compliance=report,
    )
    return _save(decision, req, "ai_decision_engine", {"request_id": req.request_id, "source": "engine"})


@app.get("/v1/decisions/{decision_id}", response_model=DecisionResponse,
         dependencies=[Depends(require_roles(READ_ROLES))])
def get_decision(decision_id: str) -> DecisionResponse:
    with connect() as conn:
        try:
            return decision_service.load_decision(conn, decision_id)
        except decision_service.DecisionNotFound:
            raise HTTPException(404, "Decisión no encontrada")


@app.post("/v1/decisions/{decision_id}/review", response_model=ReviewResponse)
def review_decision(decision_id: str, body: ReviewRequest,
                    role: str = Depends(require_roles(REVIEW_ROLES))) -> ReviewResponse:
    with connect() as conn:
        try:
            out = decision_service.review_decision(conn, decision_id, body.reviewer_id, body.action, body.comment, actor_role=role)
        except decision_service.DecisionNotFound:
            raise HTTPException(404, "Decisión no encontrada")
        except decision_service.ReviewConflict as exc:
            raise _conflict(exc)
    return ReviewResponse(
        decision_id=decision_id, review_status=out["review_status"], reviewer_id=body.reviewer_id,
        note="Aprobación registrada. Este módulo NO envía: la ejecución queda fuera de su alcance.",
    )


@app.post("/v1/agent-proposals/evaluate", response_model=DecisionResponse, status_code=201,
          dependencies=[Depends(require_roles(PROPOSE_ROLES))])
def evaluate_agent_proposal(body: AgentProposalRequest) -> DecisionResponse:
    """Puerta de validación para agentes de IA externos.

    El agente propone (estrategia, canal, momento, mensaje); este motor NO genera con LLM ni orquesta
    agentes: interpreta el riesgo con su propia evidencia, valida cumplimiento y devuelve una
    decisión explicable que queda pendiente de aprobación humana.
    """
    req, prop = body.context, body.proposal
    interp = interpreter.interpret(req)
    baseline = strategy.select_strategy(req, interp)

    if prop.contact_at is not None:
        local = to_lima(prop.contact_at)
        hour, day = local.hour, local.date()
    else:
        hour, day = req.contact_hour, req.contact_date
    proposed = Strategy(
        code=prop.strategy_code, objective="Propuesta del agente de IA", channel=prop.channel,
        contact_hour=hour, contact_date=day, proposed_offers=prop.offers,
        rationale=prop.rationale or "Sin racional provisto por el agente",
    )
    msg = DraftMessage(channel=prop.channel, language=req.customer.language,
                       subject=prop.subject, body=prop.body)
    report = compliance.review(req, proposed, msg, extra_texts=[prop.rationale, *prop.offers])

    notes: list[str] = []
    if prop.strategy_code != baseline.code:
        notes.append(f"El agente propone '{prop.strategy_code.value}' pero la banda de riesgo "
                     f"'{interp.band.value}' sugiere '{baseline.code.value}'. Requiere criterio del revisor.")
    if interp.confidence == "low":
        notes.append("Confianza baja en la interpretación del riesgo: revisar el score antes de aprobar.")

    decision = DecisionResponse(
        decision_id=str(uuid.uuid4()), request_id=req.request_id, customer_id=req.customer.customer_id,
        interpretation=interp, strategy=proposed, message=msg, compliance=report,
        source="agent_proposal",
        agent=AgentInfo(agent_id=body.agent_id, proposal_id=body.proposal_id, agent_version=body.agent_version),
        baseline_strategy=baseline.code, alignment_notes=notes,
    )
    return _save(decision, req, body.agent_id,
                 {"proposal_id": body.proposal_id, "agent_version": body.agent_version, "source": "agent_proposal"})
