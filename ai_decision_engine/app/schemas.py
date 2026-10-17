"""Contrato JSON de entrada/salida del AI Decision Engine.

Reglas del contrato:
- `extra="forbid"`: cualquier campo no declarado se rechaza (422).
- Atributos sensibles (edad, género, religión, etc.) se rechazan explícitamente
  en cualquier nivel del JSON de entrada (ver `sensitive.py`).
- Todos los datos son ficticios; `customer_id` es un seudónimo.
"""
from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .calendar_pe import TIMEZONE_NAME, to_lima
from .sensitive import find_sensitive_keys

CONTRACT_VERSION = "1.2.0"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Channel(str, Enum):
    SMS = "sms"
    EMAIL = "email"
    WHATSAPP = "whatsapp"
    PUSH = "push"
    PHONE_CALL = "phone_call"
    IN_PERSON_VISIT = "in_person_visit"


class RiskBand(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class StrategyCode(str, Enum):
    FRIENDLY_REMINDER = "friendly_reminder"
    PROACTIVE_SUPPORT = "proactive_support"
    ADVISOR_OUTREACH = "advisor_outreach"


class PaymentTrend(str, Enum):
    IMPROVING = "improving"
    STABLE = "stable"
    WORSENING = "worsening"


# ----------------------------- ENTRADA -----------------------------
class Customer(Strict):
    customer_id: str = Field(min_length=1, max_length=64, description="ID seudónimo, no PII real")
    first_name: str = Field(min_length=1, max_length=60, description="Solo para personalizar el saludo")
    language: Literal["es", "en"] = "es"
    contact_consent: list[Channel] = Field(
        min_length=0, description="Canales para los que el cliente dio consentimiento"
    )
    preferred_channel: Channel | None = None


class Account(Strict):
    product: Literal["credit_card", "personal_loan", "mortgage", "auto_loan"]
    currency: Literal["PEN", "USD"] = "PEN"
    installment_amount: float = Field(gt=0)
    next_due_date: date
    days_past_due: int = Field(ge=0, le=365, description="0 = al día (cobranza preventiva)")
    outstanding_balance: float = Field(ge=0)


class Behavior(Strict):
    missed_payments_last_6m: int = Field(ge=0, le=6)
    on_time_payment_ratio_6m: float = Field(ge=0, le=1)
    credit_utilization: float = Field(ge=0, le=1.5)
    payment_trend: PaymentTrend


class ExternalRiskScore(Strict):
    """Score calculado FUERA de este módulo. Aquí solo se interpreta."""

    value: float = Field(ge=0, le=100, description="0-100; mayor = mayor riesgo relativo. NO es una probabilidad calibrada/validada")
    model_version: str = Field(min_length=1, max_length=40)
    scored_at: date


class DecisionRequest(Strict):
    request_id: str = Field(min_length=1, max_length=64)
    customer: Customer
    account: Account
    behavior: Behavior
    risk_score: ExternalRiskScore
    local_hour: int = Field(
        default=10, ge=0, le=23,
        description="Hora (America/Lima) propuesta para el contacto. Se ignora si viene contact_at.",
    )
    contact_at: datetime | None = Field(
        default=None,
        description="Momento propuesto de contacto, con offset (ej. 2026-11-03T10:00:00-05:00). "
                    "Se convierte a America/Lima. Habilita las reglas de día hábil y feriado.",
    )
    case_version: int | None = Field(
        default=None, ge=1,
        description="Versión del expediente sobre la que se basó el contexto (opcional, aditivo en 1.2.0). "
                    "Si falta se usa la vigente. Una decisión con versión obsoleta no puede aprobarse (409).",
    )

    @model_validator(mode="after")
    def contact_at_must_be_aware(self):
        if self.contact_at is not None and self.contact_at.tzinfo is None:
            raise ValueError("contact_at debe incluir zona horaria/offset (ej. -05:00)")
        return self

    @property
    def contact_hour(self) -> int:
        return to_lima(self.contact_at).hour if self.contact_at else self.local_hour

    @property
    def contact_date(self) -> date | None:
        return to_lima(self.contact_at).date() if self.contact_at else None

    @model_validator(mode="before")
    @classmethod
    def reject_sensitive_attributes(cls, data):
        found = find_sensitive_keys(data)
        if found:
            raise ValueError(
                "Atributos sensibles prohibidos en la entrada: " + ", ".join(sorted(found))
            )
        return data


# ----------------------------- SALIDA -----------------------------
class EvidenceItem(Strict):
    field: str
    value: str
    reading: str = Field(description="Qué significa esta evidencia para el riesgo")
    direction: Literal["increases_risk", "decreases_risk", "neutral"]


class RiskInterpretation(Strict):
    band: RiskBand
    score: float
    confidence: Literal["high", "medium", "low"]
    summary: str
    score_note: str = (
        "El score es externo e ilustrativo: no es una probabilidad validada y los umbrales "
        "35/65 son supuestos de trabajo pendientes de calibración."
    )
    evidence: list[EvidenceItem]
    inconsistencies: list[str] = Field(
        default_factory=list, description="Señales que contradicen el score externo"
    )


class Strategy(Strict):
    code: StrategyCode
    objective: str
    channel: Channel | None
    contact_hour: int
    contact_date: date | None = Field(default=None, description="Fecha local (America/Lima), si se conoce")
    contact_timezone: str = TIMEZONE_NAME
    proposed_offers: list[str] = Field(
        description="Propuestas SUJETAS a evaluación; nunca compromisos automáticos"
    )
    rationale: str


class DraftMessage(Strict):
    channel: Channel | None
    language: Literal["es", "en"]
    subject: str | None = None
    body: str


class ComplianceCheck(Strict):
    rule_id: str
    description: str
    passed: bool
    detail: str = ""


class ComplianceReport(Strict):
    status: Literal["pending_human_approval", "blocked_needs_rewrite"]
    human_approval_required: Literal[True] = True
    checks: list[ComplianceCheck]
    violations: list[str]


class DeliveryInfo(Strict):
    """Garantía de no-envío: este módulo solo genera borradores."""

    sent: Literal[False] = False
    mode: Literal["draft_only"] = "draft_only"
    note: str = "El motor nunca envía mensajes. Un humano debe aprobar y otro sistema ejecutar."


class AgentInfo(Strict):
    agent_id: str = Field(min_length=1, max_length=64)
    proposal_id: str = Field(min_length=1, max_length=64)
    agent_version: str | None = Field(default=None, max_length=40)


class DecisionResponse(Strict):
    contract_version: str = CONTRACT_VERSION
    decision_id: str
    request_id: str
    customer_id: str
    interpretation: RiskInterpretation
    strategy: Strategy
    message: DraftMessage
    compliance: ComplianceReport
    delivery: DeliveryInfo = Field(default_factory=DeliveryInfo)
    review_status: Literal["pending", "approved", "rejected"] = "pending"
    source: Literal["engine", "agent_proposal"] = "engine"
    agent: AgentInfo | None = None
    baseline_strategy: StrategyCode | None = Field(
        default=None, description="Estrategia que el motor de reglas habría elegido (solo propuestas de agente)"
    )
    alignment_notes: list[str] = Field(default_factory=list)
    case_version: int | None = Field(default=None, description="Versión del expediente con la que se generó (1.2.0)")
    validity: Literal["valid", "stale"] = Field(
        default="valid", description="'stale' = invalidada por un cambio posterior del expediente (1.2.0)")
    stale_reason: str | None = None


class AgentProposal(Strict):
    """Propuesta estructurada de un agente de IA externo. El motor NO genera ni orquesta: valida."""

    strategy_code: StrategyCode
    channel: Channel
    contact_at: datetime | None = Field(
        default=None, description="Con offset. Si falta, se usa el del contexto"
    )
    subject: str | None = Field(default=None, max_length=150)
    body: str = Field(min_length=1, max_length=1500)
    offers: list[str] = Field(default_factory=list, max_length=5)
    rationale: str = Field(default="", max_length=1500)

    @model_validator(mode="after")
    def contact_at_must_be_aware(self):
        if self.contact_at is not None and self.contact_at.tzinfo is None:
            raise ValueError("contact_at debe incluir zona horaria/offset (ej. -05:00)")
        return self


class AgentProposalRequest(Strict):
    proposal_id: str = Field(min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=64)
    agent_version: str | None = Field(default=None, max_length=40)
    context: DecisionRequest
    proposal: AgentProposal


class ReviewRequest(Strict):
    reviewer_id: str = Field(min_length=1, max_length=64)
    action: Literal["approve", "reject"]
    comment: str = Field(default="", max_length=500)


class ReviewResponse(Strict):
    decision_id: str
    review_status: Literal["approved", "rejected"]
    reviewer_id: str
    delivery: DeliveryInfo = Field(default_factory=DeliveryInfo)
    note: str
