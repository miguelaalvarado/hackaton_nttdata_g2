"""Calendario de contacto para Perú (zona horaria America/Lima, sin horario de verano).

IMPORTANTE: la lista de feriados es una aproximación conservadora (incluye feriados nacionales
vigentes y recientes). Debe ser validada por Legal/Cumplimiento contra el calendario oficial
(El Peruano) cada año. No incluye "días no laborables" decretados ad hoc (puentes).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

LIMA = ZoneInfo("America/Lima")
TIMEZONE_NAME = "America/Lima"

_FIXED = {
    (1, 1): "Año Nuevo", (5, 1): "Día del Trabajo",
    (6, 7): "Batalla de Arica y Día de la Bandera", (6, 29): "San Pedro y San Pablo",
    (7, 23): "Día de la Fuerza Aérea", (7, 28): "Fiestas Patrias", (7, 29): "Fiestas Patrias",
    (8, 6): "Batalla de Junín", (8, 30): "Santa Rosa de Lima", (10, 8): "Combate de Angamos",
    (11, 1): "Día de Todos los Santos", (12, 8): "Inmaculada Concepción",
    (12, 9): "Batalla de Ayacucho", (12, 25): "Navidad",
}


def _easter(year: int) -> date:
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return date(year, month, day)


def holiday_name(d: date) -> str | None:
    if (d.month, d.day) in _FIXED:
        return _FIXED[(d.month, d.day)]
    easter = _easter(d.year)
    if d == easter - timedelta(days=3):
        return "Jueves Santo"
    if d == easter - timedelta(days=2):
        return "Viernes Santo"
    return None


def is_business_day(d: date) -> bool:
    """Lunes a viernes y no feriado (los sábados NO cuentan: política conservadora)."""
    return d.weekday() < 5 and holiday_name(d) is None


def to_lima(dt: datetime) -> datetime:
    return dt.astimezone(LIMA)
