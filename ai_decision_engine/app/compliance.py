"""Supervisor de cumplimiento. Nada se ejecuta sin aprobación humana, ni siquiera si todo pasa."""
from __future__ import annotations

import re

from .calendar_pe import holiday_name
from .schemas import (
    Channel, ComplianceCheck, ComplianceReport, DecisionRequest, DraftMessage, Strategy,
)
from .sensitive import mentions_sensitive_text

CONTACT_WINDOW = (8, 20)  # 08:00 a 19:59 America/Lima. Política interna conservadora, todos los canales.
# Canales intrusivos/presenciales: además solo en día hábil (lun-vie, sin feriados).
BUSINESS_DAY_CHANNELS = {Channel.PHONE_CALL, Channel.IN_PERSON_VISIT}

PRESSURE_PATTERN = re.compile(
    r"\b(embargo|embargar|demanda|demandar|polic[ií]a|c[aá]rcel|centrales de riesgo|infocorp|"
    r"reportar|reportaremos|deshonra|verg[uü]enza|[uú]ltimo aviso|urgente|inmediatamente|"
    r"lawsuit|sue|arrest|blacklist|final notice)\b",
    re.IGNORECASE,
)
GUARANTEE_PATTERN = re.compile(
    r"\b(garantizado|garantizamos|aprobado|condonamos|sin intereses|te perdonamos|guaranteed|waive[sd]?)\b",
    re.IGNORECASE,
)
HEDGE_PATTERN = re.compile(r"sujet[oa]s? a (evaluaci[oó]n|aprobaci[oó]n)|subject to review", re.IGNORECASE)
OPT_OUT_PATTERN = re.compile(r"\b(BAJA|STOP)\b")


def review(req: DecisionRequest, strategy: Strategy, message: DraftMessage,
           extra_texts: list[str] | None = None) -> ComplianceReport:
    checks: list[ComplianceCheck] = []

    def check(rule_id, description, passed, detail=""):
        checks.append(ComplianceCheck(rule_id=rule_id, description=description, passed=passed,
                                      detail="" if passed else detail))

    check("C01", "Existe canal con consentimiento del cliente",
          message.channel is not None and message.channel in req.customer.contact_consent,
          "Sin canal consentido: no se puede contactar.")

    lo, hi = CONTACT_WINDOW
    check("C02", f"Hora de contacto dentro de {lo:02d}:00-{hi:02d}:00",
          lo <= strategy.contact_hour < hi, f"Hora {strategy.contact_hour}:00 fuera de ventana permitida.")

    day = strategy.contact_date
    if message.channel in BUSINESS_DAY_CHANNELS and day is not None:
        holiday = holiday_name(day)
        check("C09", "Llamadas/visitas solo en día hábil (lunes a viernes)", day.weekday() < 5,
              f"{day.isoformat()} es fin de semana.")
        check("C10", "Llamadas/visitas no en feriado", holiday is None, f"{day.isoformat()}: {holiday}.")
    else:
        why = "canal sin restricción de día" if message.channel not in BUSINESS_DAY_CHANNELS else "sin fecha de contacto"
        check("C09", f"Día hábil para llamadas/visitas (no aplica: {why})", True)
        check("C10", f"Feriados para llamadas/visitas (no aplica: {why})", True)

    pressure = sorted({m.group(0).lower() for m in PRESSURE_PATTERN.finditer(message.body)})
    check("C03", "Sin lenguaje amenazante o de presión", not pressure, f"Términos: {pressure}")

    sensitive = mentions_sensitive_text(message.body)
    check("C04", "Sin referencias a atributos sensibles", not sensitive, f"Términos: {sensitive}")

    guarantees = sorted({m.group(0).lower() for m in GUARANTEE_PATTERN.finditer(message.body)})
    has_offers = bool(strategy.proposed_offers)
    hedged = bool(HEDGE_PATTERN.search(message.body)) or not has_offers
    check("C05", "Ofertas sin compromisos automáticos (sujetas a evaluación)",
          not guarantees and hedged, f"Promesas: {guarantees}; ofertas condicionadas: {hedged}")

    check("C06", "Incluye mecanismo de baja (opt-out)", bool(OPT_OUT_PATTERN.search(message.body)),
          "Falta instrucción de baja.")

    if extra_texts is not None:
        joined = "\n".join(extra_texts)
        bad = sorted({m.group(0).lower() for m in PRESSURE_PATTERN.finditer(joined)}
                     | {m.group(0).lower() for m in GUARANTEE_PATTERN.finditer(joined)}
                     | set(mentions_sensitive_text(joined)))
        check("C11", "Racional/ofertas del agente sin presión, promesas ni atributos sensibles",
              not bad, f"Términos: {bad}")

    check("C07", "Modo borrador: sin envío real", True)
    check("C08", "Requiere aprobación humana antes de cualquier acción", True)

    violations = [f"{c.rule_id}: {c.detail}" for c in checks if not c.passed]
    return ComplianceReport(
        status="blocked_needs_rewrite" if violations else "pending_human_approval",
        checks=checks, violations=violations,
    )
