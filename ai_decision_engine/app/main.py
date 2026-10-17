"""API FastAPI del AI Decision Engine (MVP, solo datos ficticios, sin envíos reales)."""
from __future__ import annotations

import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .calendar_pe import to_lima
from . import compliance, interpreter, messages, strategy
from .schemas import (
    CONTRACT_VERSION, AgentInfo, AgentProposalRequest, DecisionRequest, DecisionResponse, DraftMessage,
    ReviewRequest, ReviewResponse, Strategy,
)

app = FastAPI(title="AI Decision Engine - Cobranza temprana", version=CONTRACT_VERSION,
              description="Módulo independiente. Genera borradores; nunca envía mensajes.")

# Orígenes del frontend (ej: "http://localhost:5173,http://localhost:3000")
_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["GET", "POST"], allow_headers=["*"])

# Almacén en memoria (MVP). Se pierde al reiniciar.
_DECISIONS: dict[str, DecisionResponse] = {}


@app.get("/health")
def health():
    return {"status": "ok", "contract_version": CONTRACT_VERSION, "sends_messages": False}


@app.get("/v1/contract")
def contract():
    return {"request": DecisionRequest.model_json_schema(), "response": DecisionResponse.model_json_schema(),
            "agent_proposal_request": AgentProposalRequest.model_json_schema()}


@app.post("/v1/decisions", response_model=DecisionResponse, status_code=201)
def create_decision(req: DecisionRequest) -> DecisionResponse:
    interp = interpreter.interpret(req)
    strat = strategy.select_strategy(req, interp)
    msg = messages.draft_message(req, strat)
    report = compliance.review(req, strat, msg)
    decision = DecisionResponse(
        decision_id=str(uuid.uuid4()), request_id=req.request_id, customer_id=req.customer.customer_id,
        interpretation=interp, strategy=strat, message=msg, compliance=report,
    )
    _DECISIONS[decision.decision_id] = decision
    return decision


@app.get("/v1/decisions/{decision_id}", response_model=DecisionResponse)
def get_decision(decision_id: str) -> DecisionResponse:
    if decision_id not in _DECISIONS:
        raise HTTPException(404, "Decisión no encontrada")
    return _DECISIONS[decision_id]


@app.post("/v1/decisions/{decision_id}/review", response_model=ReviewResponse)
def review_decision(decision_id: str, body: ReviewRequest) -> ReviewResponse:
    decision = _DECISIONS.get(decision_id)
    if decision is None:
        raise HTTPException(404, "Decisión no encontrada")
    if body.action == "approve" and decision.compliance.status == "blocked_needs_rewrite":
        raise HTTPException(409, "No se puede aprobar una decisión bloqueada por cumplimiento")
    if decision.review_status != "pending":
        raise HTTPException(409, f"La decisión ya fue {decision.review_status}")
    decision.review_status = "approved" if body.action == "approve" else "rejected"
    return ReviewResponse(
        decision_id=decision_id, review_status=decision.review_status, reviewer_id=body.reviewer_id,
        note="Aprobación registrada. Este módulo NO envía: la ejecución queda fuera de su alcance.",
    )


@app.post("/v1/agent-proposals/evaluate", response_model=DecisionResponse, status_code=201)
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
    _DECISIONS[decision.decision_id] = decision
    return decision
