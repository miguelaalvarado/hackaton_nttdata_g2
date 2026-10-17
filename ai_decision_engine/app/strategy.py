"""Selección de estrategia preventiva a partir de la interpretación."""
from __future__ import annotations

from .schemas import (
    Channel, DecisionRequest, RiskBand, RiskInterpretation, Strategy, StrategyCode,
)

# Canal por defecto según intensidad; se ajusta al consentimiento del cliente.
CHANNEL_PRIORITY = {
    RiskBand.LOW: [Channel.PUSH, Channel.EMAIL, Channel.SMS, Channel.WHATSAPP],
    RiskBand.MEDIUM: [Channel.WHATSAPP, Channel.SMS, Channel.EMAIL, Channel.PUSH],
    RiskBand.HIGH: [Channel.PHONE_CALL, Channel.WHATSAPP, Channel.SMS, Channel.EMAIL],
}


def pick_channel(req: DecisionRequest, band: RiskBand) -> Channel | None:
    consented = set(req.customer.contact_consent)
    pref = req.customer.preferred_channel
    if pref in consented:
        return pref
    for ch in CHANNEL_PRIORITY[band]:
        if ch in consented:
            return ch
    return None


def select_strategy(req: DecisionRequest, interp: RiskInterpretation) -> Strategy:
    band = interp.band
    channel = pick_channel(req, band)
    hour, day = req.contact_hour, req.contact_date

    if band == RiskBand.LOW:
        return Strategy(
            code=StrategyCode.FRIENDLY_REMINDER,
            objective="Recordar la fecha de pago con tono amable y refuerzo positivo.",
            channel=channel, contact_hour=hour, contact_date=day, proposed_offers=[],
            rationale="Riesgo bajo: el cliente suele pagar a tiempo; un recordatorio ligero evita fricción.",
        )
    if band == RiskBand.MEDIUM:
        return Strategy(
            code=StrategyCode.PROACTIVE_SUPPORT,
            objective="Anticipar posibles dificultades y ofrecer opciones de apoyo antes del vencimiento.",
            channel=channel, contact_hour=hour, contact_date=day,
            proposed_offers=["Reprogramación de fecha de pago (sujeta a evaluación)",
                             "Pago en canales digitales sin comisión adicional (si aplica)"],
            rationale="Riesgo medio: hay señales mixtas; conviene ofrecer ayuda de forma proactiva.",
        )
    offers = ["Conversación con un asesor para revisar el plan de pagos",
              "Evaluación de reprogramación o refinanciamiento (sujeta a aprobación)"]
    rationale = "Riesgo alto: se prioriza contacto humano cercano y opciones de apoyo antes de que haya atraso."
    if interp.confidence == "low":
        rationale += " Confianza baja: revisar el score antes de actuar."
    return Strategy(
        code=StrategyCode.ADVISOR_OUTREACH,
        objective="Contacto empático con asesor para acordar una solución sostenible.",
        channel=channel, contact_hour=hour, contact_date=day, proposed_offers=offers, rationale=rationale,
    )
