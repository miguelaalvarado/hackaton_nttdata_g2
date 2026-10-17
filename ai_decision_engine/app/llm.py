"""Adaptador OPCIONAL de IA generativa (solo Conversational Agent). Apagado salvo que exista ANTHROPIC_API_KEY.

- La clave se lee del entorno (nunca del repo ni de logs). Sin clave => el componente usa plantillas y se etiqueta 'rules'.
- El LLM solo redacta el cuerpo del borrador. El pie con la baja (BAJA/STOP) lo añade el código, y el borrador sigue pasando
  por el AI Decision Engine (cumplimiento) y por revisión humana. El LLM no ve saldos totales ni puede modificar datos.
- Si la llamada falla, el orquestador cae a plantillas y deja el error en la traza.
"""
from __future__ import annotations

import json
import os

SYSTEM = (
    "Eres un redactor de mensajes de cobranza temprana, empático y respetuoso, para un banco. Redacta SOLO el cuerpo del "
    "mensaje (máx. 80 palabras) en el idioma indicado. Reglas: sin amenazas ni presión, sin mencionar embargos, demandas, "
    "centrales de riesgo ni consecuencias; sin garantizar ni prometer condonaciones o aprobaciones (si hay opciones, "
    "indícalas como 'sujetas a evaluación'); sin referirte a edad, género, salud, religión u otros atributos personales; "
    "usa únicamente los datos entregados; NO incluyas instrucciones de baja ni despedidas legales (las añade el sistema)."
)


def enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY")) and os.getenv("NEXO_LLM_ENABLED", "1") != "0"


def model_name() -> str:
    return os.getenv("NEXO_LLM_MODEL", "claude-sonnet-5-5")


def draft_body(*, first_name: str, language: str, amount: str, due_date: str, objective: str, offers: list[str],
               last_reply: str | None, client=None) -> str:
    """Redacta el cuerpo con un LLM. `client` permite inyectar un doble en pruebas."""
    if client is None:
        import anthropic  # import tardío: dependencia opcional
        client = anthropic.Anthropic()
    payload = {"idioma": language, "nombre": first_name, "monto_cuota": amount, "vence": due_date,
               "objetivo": objective, "opciones_condicionadas": offers, "ultima_respuesta_del_cliente": last_reply}
    resp = client.messages.create(model=model_name(), max_tokens=400, system=SYSTEM,
                                  messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}])
    text = "".join(getattr(b, "text", "") for b in resp.content).strip()
    if not text:
        raise ValueError("El modelo devolvió una respuesta vacía")
    return text
