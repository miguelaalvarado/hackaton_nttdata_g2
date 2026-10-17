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


_dotenv_loaded = False


def load_dotenv_once() -> None:
    """Carga `.env` (ignorado por git) sin dependencias. No pisa variables ya definidas. NEXO_DISABLE_DOTENV=1 lo desactiva."""
    global _dotenv_loaded
    if _dotenv_loaded or os.getenv("NEXO_DISABLE_DOTENV") == "1":
        return
    _dotenv_loaded = True
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if not os.path.isfile(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def provider() -> str | None:
    """'openai' | 'anthropic' | None. LLM_PROVIDER manda; sin ella, solo se infiere Anthropic por compatibilidad."""
    load_dotenv_once()
    if os.getenv("NEXO_LLM_ENABLED", "1") == "0":
        return None
    p = os.getenv("LLM_PROVIDER", "").strip().lower()
    if p == "openai":
        return "openai" if os.getenv("OPENAI_API_KEY") else None
    if p == "anthropic" or (not p and os.getenv("ANTHROPIC_API_KEY")):
        return "anthropic" if os.getenv("ANTHROPIC_API_KEY") else None
    return None


def status() -> dict:
    """Estado de configuración para mostrar en la UI. NUNCA incluye claves."""
    load_dotenv_once()
    p = provider()
    return {"requested": os.getenv("LLM_PROVIDER", "") or "(no definido)", "active": p,
            "model": openai_model() if p == "openai" else (model_name() if p == "anthropic" else None),
            "openai_key_present": bool(os.getenv("OPENAI_API_KEY")), "anthropic_key_present": bool(os.getenv("ANTHROPIC_API_KEY"))}


def openai_model() -> str:
    return os.getenv("OPENAI_MODEL", "").strip()


def enabled() -> bool:
    """Compatibilidad: ¿está activo el adaptador de redacción de Anthropic?"""
    return provider() == "anthropic"


def openai_client():
    from openai import OpenAI  # import tardío: dependencia opcional
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=float(os.getenv("OPENAI_TIMEOUT", "40")), max_retries=1)


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
