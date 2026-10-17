"""Interpretación del riesgo basada en evidencia.

El score es externo. Aquí se contrasta con señales observables (solo financieras/conductuales)
y se explica cada una. Si las señales contradicen el score, se baja la confianza para forzar
atención humana; nunca se reemplaza el score.
"""
from __future__ import annotations

from .schemas import (
    DecisionRequest, EvidenceItem, PaymentTrend, RiskBand, RiskInterpretation,
)

LOW_MAX = 35.0
MEDIUM_MAX = 65.0


def band_for(score: float) -> RiskBand:
    if score < LOW_MAX:
        return RiskBand.LOW
    if score <= MEDIUM_MAX:
        return RiskBand.MEDIUM
    return RiskBand.HIGH


def _evidence(req: DecisionRequest) -> list[tuple[EvidenceItem, int]]:
    """Devuelve (evidencia, peso) con peso +1 sube riesgo, -1 baja, 0 neutro."""
    a, b = req.account, req.behavior
    out: list[tuple[EvidenceItem, int]] = []

    def add(field, value, reading, direction):
        out.append((EvidenceItem(field=field, value=str(value), reading=reading, direction=direction),
                    {"increases_risk": 1, "decreases_risk": -1, "neutral": 0}[direction]))

    if b.missed_payments_last_6m >= 2:
        add("behavior.missed_payments_last_6m", b.missed_payments_last_6m,
            "Varios pagos omitidos recientes indican dificultad sostenida", "increases_risk")
    elif b.missed_payments_last_6m == 0:
        add("behavior.missed_payments_last_6m", 0, "Sin pagos omitidos en 6 meses", "decreases_risk")
    else:
        add("behavior.missed_payments_last_6m", b.missed_payments_last_6m,
            "Un pago omitido aislado; señal débil", "neutral")

    if b.on_time_payment_ratio_6m < 0.6:
        add("behavior.on_time_payment_ratio_6m", b.on_time_payment_ratio_6m,
            "Baja puntualidad histórica", "increases_risk")
    elif b.on_time_payment_ratio_6m >= 0.9:
        add("behavior.on_time_payment_ratio_6m", b.on_time_payment_ratio_6m,
            "Alta puntualidad histórica", "decreases_risk")

    if b.credit_utilization > 0.85:
        add("behavior.credit_utilization", b.credit_utilization,
            "Uso de línea muy alto: poco margen de liquidez", "increases_risk")
    elif b.credit_utilization < 0.4:
        add("behavior.credit_utilization", b.credit_utilization,
            "Uso de línea holgado", "decreases_risk")

    trend_map = {
        PaymentTrend.WORSENING: ("Tendencia de pago en deterioro", "increases_risk"),
        PaymentTrend.IMPROVING: ("Tendencia de pago en mejora", "decreases_risk"),
        PaymentTrend.STABLE: ("Tendencia de pago estable", "neutral"),
    }
    reading, direction = trend_map[b.payment_trend]
    add("behavior.payment_trend", b.payment_trend.value, reading, direction)

    if a.days_past_due > 0:
        add("account.days_past_due", a.days_past_due,
            "Ya hay atraso; el caso deja de ser puramente preventivo", "increases_risk")
    return out


def interpret(req: DecisionRequest) -> RiskInterpretation:
    score = req.risk_score.value
    band = band_for(score)
    pairs = _evidence(req)
    evidence = [e for e, _ in pairs]
    net = sum(w for _, w in pairs)

    inconsistencies: list[str] = []
    if band == RiskBand.HIGH and net <= -2:
        inconsistencies.append("Score alto pero la evidencia conductual es favorable; revisar el score.")
    if band == RiskBand.LOW and net >= 2:
        inconsistencies.append("Score bajo pero la evidencia conductual indica deterioro; revisar el score.")

    if inconsistencies:
        confidence = "low"
    elif abs(net) >= 2 or len(evidence) >= 3 and (
        (band == RiskBand.HIGH and net > 0) or (band == RiskBand.LOW and net < 0)
    ):
        confidence = "high"
    else:
        confidence = "medium"

    label = {"low": "bajo", "medium": "medio", "high": "alto"}[band.value]
    up = sum(1 for _, w in pairs if w > 0)
    down = sum(1 for _, w in pairs if w < 0)
    summary = (
        f"Riesgo {label} (score {score:.0f}/100, modelo {req.risk_score.model_version}). "
        f"{up} señal(es) que aumentan el riesgo y {down} que lo reducen. Confianza {confidence}."
    )
    return RiskInterpretation(
        band=band, score=score, confidence=confidence, summary=summary,
        evidence=evidence, inconsistencies=inconsistencies,
    )
