"""Ejecución REAL del Conversational Agent con OpenAI sobre datos SINTÉTICOS, con verificación contra SQLite.

    python3 -m scripts.demo_openai                       # caso nuevo + respuesta ficticia por defecto
    python3 -m scripts.demo_openai --reply "No puedo pagar este mes, ¿puedo pagar la mitad el día 30?"
Usa la misma base que Streamlit (NEXO_DB_PATH). Sale con código 2 si la ejecución NO usó OpenAI (p. ej. cayó al fallback de reglas).
"""
from __future__ import annotations

import argparse
import json
import sys

from app import llm
from app.db import connect
from app.events import EventIn, process_event
from app.orchestrator import propose_case
from app.seed import create_demo_case

DEFAULT_REPLY = "Hola, este mes me recortaron horas en el trabajo y no me alcanza. ¿Podría pagar la mitad el día 30 y el resto después?"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reply", default=DEFAULT_REPLY)
    ap.add_argument("--customer", help="cliente existente (por defecto crea un caso demo nuevo)")
    a = ap.parse_args()
    llm.load_dotenv_once()
    st = llm.status()
    print(f"Proveedor activo: {st['active']} · modelo: {st['model']}")
    if st["active"] != "openai":
        print("✘ OpenAI no está activo. Ejecuta primero: python3 -m scripts.check_openai")
        return 2
    with connect() as c:
        cid = a.customer or create_demo_case(c)
        before = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in ("payments", "promises", "decisions")}
        loan0 = c.execute("select outstanding_cents from loans where customer_id=?", (cid,)).fetchall()
        process_event(c, EventIn(event_id=f"demo-reply-{cid}", event_type="CUSTOMER_REPLIED", customer_id=cid,
                                 source="customer_channel", payload={"text": a.reply, "channel": "email"}))
    print(f"\nCliente sintético: {cid}\nRespuesta ficticia: {a.reply!r}\n")
    out = propose_case(cid)
    if out["halted"]:
        print("✘ Orquestador detenido:", out["reason"])
        return 2
    conv = out["conversational"]
    print(f"Motor del Conversational Agent: {conv['engine']}  (resultado: {conv['result']})")
    if conv["engine"] == "rules":
        print("✘ NO se usó OpenAI. Motivo:", json.dumps(conv.get("fallback"), ensure_ascii=False))
        return 2
    step = next(s["output"] for s in out["steps"] if s["agent"] == "conversational_agent")
    print(f"Herramientas consultadas: {conv['tools_used']} · {conv['duration_ms']} ms · tokens {conv['usage']}")
    print(f"Interpretación: [{conv['customer_intent']}/{conv['intent_confidence']}] {conv['interpretation']}")
    print(f"\nPropuesta → estrategia={out['proposed']['strategy']} canal={out['proposed']['channel']} (canal decidido por reglas)")
    print(f"Ofertas: {out['proposed']['offers']}\n\nBorrador:\n{step['body']}\n")
    print(f"AI Decision Engine → {out['compliance_status']} · violaciones={out['violations']} · revisión={out['review_status']} · enviado={out['sent']}")
    with connect() as c:
        after = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in ("payments", "promises", "decisions")}
        loan1 = c.execute("select outstanding_cents from loans where customer_id=?", (cid,)).fetchall()
        run = c.execute("select output_json from agent_runs where agent_name='conversational_agent' and customer_id=? order by started_at desc, rowid desc limit 1", (cid,)).fetchone()
    logged = json.loads(run[0])
    assert after["payments"] == before["payments"] and after["promises"] == before["promises"] and loan0 == loan1, "el LLM no debe tocar dinero ni compromisos"
    assert after["decisions"] == before["decisions"] + 1 and out["review_status"] == "pending"
    assert logged["provider"] == "openai" and logged["engine"].startswith("llm:openai:") and logged["tools_used"]
    print(f"\n✔ Verificado en SQLite: agent_runs registra provider={logged['provider']} model={logged['model']} tools={logged['tools_used']} "
          f"duration_ms={logged['duration_ms']}; pagos/promesas/saldo sin cambios; decisión PENDIENTE de aprobación humana.")
    print(f"→ Ábrelo en Streamlit: Demo guiada (cliente {cid}) y Mapa de componentes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
