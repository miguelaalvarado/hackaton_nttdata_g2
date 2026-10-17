"""Autorización de la frontera HTTP (única fuente de verdad de roles y permisos).

- Las claves viven SOLO en el entorno: NEXO_INTEGRATION_KEYS='{"<clave>":"<rol>", ...}'. Nunca en código, logs ni repo.
- Fail-closed: sin claves configuradas, o con clave ausente/incorrecta, no se accede a nada protegido.
- Roles: human, bank_simulator, customer_channel, agent, system, reader. `untrusted` = sin credencial válida (no puede nada).
- El rol sale de la credencial, jamás del cuerpo del request.
- El dashboard local NO pasa por aquí (ver README): llama a los servicios en proceso como consola humana de confianza.
"""
from __future__ import annotations

import json
import logging
import os
import secrets

from fastapi import Header, HTTPException

log = logging.getLogger("nexo.auth")

ROLES = {"human", "bank_simulator", "customer_channel", "agent", "system", "reader"}
UNTRUSTED = "untrusted"

# Quién puede registrar cada evento. Los pagos solo los confirma el simulador bancario; la revisión, solo un humano.
EVENT_PERMISSIONS: dict[str, set[str]] = {
    "PAYMENT_POSTED": {"bank_simulator"},
    "PAYMENT_PENDING": {"bank_simulator"},
    "PAYMENT_REVERSED": {"bank_simulator"},
    "HUMAN_REVIEW": {"human"},
    "CUSTOMER_REPLIED": {"customer_channel", "agent", "system", "human"},
    "PROMISE_CREATED": {"customer_channel", "agent", "system", "human"},
    "CONTACT_OPT_OUT": {"customer_channel", "agent", "system", "human"},
    "DISPUTE_OPENED": {"customer_channel", "agent", "system", "human"},
    "PROMISE_DUE": {"agent", "system", "human"},
    "CONTACT_RECORDED": {"agent", "system", "human"},
    "INVESTIGATE": {"agent", "system", "human"},
}
READ_ROLES = {"human", "agent", "system", "reader"}          # lectura de expedientes
PROPOSE_ROLES = {"agent", "system", "human"}                 # crear/evaluar decisiones (quedan pendientes)
REVIEW_ROLES = {"human"}                                     # aprobar / rechazar
OPERATE_ROLES = {"human", "system"}                          # scheduler, política, reevaluación, ejecución simulada


def _keys() -> dict[str, str]:
    try:
        raw = json.loads(os.getenv("NEXO_INTEGRATION_KEYS", "{}"))
    except json.JSONDecodeError:
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and k and v in ROLES}


def role_for_key(key: str | None) -> str:
    if not key:
        return UNTRUSTED
    found = UNTRUSTED
    for k, role in _keys().items():  # recorre todas: tiempo constante respecto a cuál coincide
        if secrets.compare_digest(k.encode(), key.encode()):
            found = role
    return found


def require_roles(allowed: set[str]):
    """Dependencia FastAPI. 401 = credencial ausente/inválida; 403 = credencial válida sin permiso. No toca la BD."""
    def dep(x_integration_key: str | None = Header(default=None)) -> str:
        role = role_for_key(x_integration_key)
        if role == UNTRUSTED:
            log.warning("acceso denegado: credencial ausente o inválida")
            raise HTTPException(401, {"code": "UNAUTHENTICATED", "message": "Credencial de integración requerida o inválida"})
        if role not in allowed:
            log.warning("acceso denegado: rol %s no permitido", role)
            raise HTTPException(403, {"code": "FORBIDDEN_ROLE", "message": f"El rol '{role}' no está autorizado para esta operación"})
        return role
    return dep


def event_allowed(event_type: str, role: str) -> bool:
    return role in EVENT_PERMISSIONS.get(event_type, set())
