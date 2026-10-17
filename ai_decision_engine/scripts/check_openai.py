"""Comprueba la configuración de OpenAI con una llamada REAL mínima. Nunca imprime la clave.

    python3 -m scripts.check_openai
Lee LLM_PROVIDER / OPENAI_API_KEY / OPENAI_MODEL del entorno o de ai_decision_engine/.env (ignorado por git).
"""
from __future__ import annotations

import sys
import time

from app import llm


def main() -> int:
    llm.load_dotenv_once()
    st = llm.status()
    print(f"proveedor solicitado : {st['requested']}\nproveedor activo     : {st['active']}\nmodelo (OPENAI_MODEL): {st['model'] or '(no definido)'}\n"
          f"OPENAI_API_KEY       : {'presente' if st['openai_key_present'] else 'AUSENTE'}")
    if st["requested"] != "openai" or not st["openai_key_present"] or not llm.openai_model():
        print("\n✘ Configura LLM_PROVIDER=openai, OPENAI_API_KEY y OPENAI_MODEL (ver .env.example).")
        return 2
    client = llm.openai_client()
    model = llm.openai_model()
    try:
        m = client.models.retrieve(model)
        print(f"\n[1] Modelo disponible: id={m.id} propietario={getattr(m, 'owned_by', '?')}")
    except Exception as exc:  # noqa: BLE001
        print(f"\n✘ [1] El modelo '{model}' no está disponible para esta clave: {type(exc).__name__}: {str(exc)[:200]}")
        return 3
    t0 = time.perf_counter()
    try:
        r = client.responses.create(model=model, input="Responde únicamente con la palabra OK.", max_output_tokens=256, store=False)
    except Exception as exc:  # noqa: BLE001
        print(f"✘ [2] Falló la llamada a Responses API: {type(exc).__name__}: {str(exc)[:200]}")
        return 4
    ms = int((time.perf_counter() - t0) * 1000)
    u = r.usage
    print(f"[2] Responses API OK · respuesta={r.output_text.strip()[:40]!r} · {ms} ms · tokens in/out={u.input_tokens}/{u.output_tokens} · id={r.id}")
    print("\n✔ OpenAI listo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
