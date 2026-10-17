"""Demo extremo a extremo (10 pasos) contra la API REAL, con autenticación por rol.

Uso (servidor ya levantado con NEXO_INTEGRATION_KEYS y NEXO_ENABLE_DEV_SEED=1):
    NEXO_INTEGRATION_KEYS='{"..":"human",..}' python3 -m scripts.demo_flow --base-url http://localhost:8000 --customer CLI-0003
Las claves se leen del entorno; nunca se imprimen. Cada paso afirma el resultado leyendo la BD vía API: si algo falla, aborta.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime

REQUIRED_AGENTS = {"risk_agent", "strategy_agent", "contact_agent", "conversational_agent", "negotiation_agent",
                   "compliance_agent"}


def keys_by_role() -> dict[str, str]:
    inv = {}
    for key, role in json.loads(os.environ["NEXO_INTEGRATION_KEYS"]).items():
        inv.setdefault(role, key)
    return inv


class Flow:
    def __init__(self, http, keys: dict[str, str], customer: str, verbose: bool = True):
        self.http, self.keys, self.cid, self.verbose = http, keys, customer, verbose
        self.report: list[dict] = []

    def call(self, method: str, path: str, role: str, expect: int | tuple = 200, **kw):
        r = self.http.request(method, path, headers={"X-Integration-Key": self.keys[role]}, **kw)
        ok = r.status_code in ((expect,) if isinstance(expect, int) else expect)
        assert ok, f"{method} {path} como {role}: esperado {expect}, obtuvo {r.status_code}: {r.text[:300]}"
        return r.json() if r.content else None

    def step(self, n: int, title: str, **facts):
        self.report.append({"step": n, "title": title, **facts})
        if self.verbose:
            print(f"\n[{n:>2}] {title}")
            for k, v in facts.items():
                print(f"     {k}: {v}")

    def state(self) -> dict:
        return self.call("GET", f"/v1/customers/{self.cid}", "reader")

    def run(self) -> list[dict]:
        cid = self.cid
        # 1. Consulta desde la base persistente
        st0 = self.state()
        inst = st0["customer"]["current_installment"]
        loan0 = st0["loans"][0]["outstanding_cents"]
        remaining = inst["amount_cents"] - inst["paid_cents"]
        v0 = st0["customer"]["case_version"]
        self.step(1, "Consulta del cliente desde la BD persistente", cliente=cid, saldo_cents=loan0,
                  cuota=inst["installment_id"], pendiente_cents=remaining, case_version=v0)

        # 2-5. Orquestador: riesgo → estrategia → contacto → validación del Decision Engine
        out = self.call("POST", "/v1/orchestrator/run", "agent", 200, json={"customer_id": cid})
        assert not out["halted"], f"Orquestador detenido: {out.get('reason')}"
        agents = {s["agent"] for s in out["steps"]}
        assert REQUIRED_AGENTS <= agents, f"faltan componentes: {REQUIRED_AGENTS - agents}"
        steps = {s["agent"]: s["output"] for s in out["steps"]}
        d1 = out["decision_id"]
        assert out["review_status"] == "pending" and out["sent"] is False and out["requires_human_approval"]
        self.step(2, "Análisis de riesgo (Risk Agent)", banda=steps["risk_agent"]["band"], score=steps["risk_agent"]["score"],
                  confianza=steps["risk_agent"]["confidence"])
        self.step(3, "Estrategia y contacto (Strategy + Contact + Conversational + Negotiation)",
                  estrategia=out["proposed"]["strategy"], canal=out["proposed"]["channel"],
                  contacto_propuesto=out["proposed"]["contact_at"], ofertas=out["proposed"]["offers"])
        self.step(4, "Validación del AI Decision Engine (Compliance)", decision_id=d1, estado=out["compliance_status"],
                  violaciones=out["violations"], review_status=out["review_status"], enviado=out["sent"])
        assert out["compliance_status"] == "pending_human_approval", f"bloqueada por cumplimiento: {out['violations']}"

        # 5. Aprobación humana (rol human) y sus negativas
        self.call("POST", f"/v1/decisions/{d1}/review", "agent", 403, json={"reviewer_id": "x", "action": "approve"})
        ap = self.call("POST", f"/v1/decisions/{d1}/review", "human", 200, json={"reviewer_id": "analista-demo", "action": "approve"})
        st1 = self.state()
        act = next(a for a in st1["scheduled_actions"] if a["decision_id"] == d1 and a["status"] in ("PENDING", "DUE"))
        self.step(5, "Aprobación humana → acción programada vinculada a la decisión",
                  agent_no_puede_aprobar="403", aprobada_por="analista-demo", accion=act["action_type"], canal=act["channel"],
                  programada=act["scheduled_at"], justificacion=act["reason"][:140])

        # 6. Registro de gestión (ejecución SIMULADA con revalidación) y próxima fecha de seguimiento
        ex = self.call("POST", f"/v1/scheduled-actions/{act['action_id']}/execute", "system", 200, json={"now": act["scheduled_at"]})
        assert ex["executed"] and ex["sent_real_message"] is False, ex
        fu = self.call("POST", f"/v1/orchestrator/followup/{cid}", "system", 200, json={})
        st2 = self.state()
        contact = next(c for c in st2["contact_history"] if c["action_id"] == act["action_id"])
        assert contact["outcome"] == "SIMULATED_SENT" and contact["decision_id"] == d1
        assert fu["next_followup_at"] and fu["next_followup_at"] > act["scheduled_at"]
        self.step(6, "Registro de gestión y próxima fecha de seguimiento (Follow-up Agent)", contacto=f"{contact['channel']} {contact['outcome']}",
                  mensaje_real_enviado=ex["sent_real_message"], proximo_seguimiento=fu["next_followup_at"],
                  tipo=fu["next_action"]["action_type"] if fu["next_action"] else None)

        # 7. Nueva propuesta pendiente (se invalidará con el pago) y pago confirmado por el simulador bancario
        out2 = self.call("POST", "/v1/orchestrator/run", "agent", 200, json={"customer_id": cid})
        d2 = out2["decision_id"]
        assert out2["review_status"] == "pending"
        ref = f"DEMO-{uuid.uuid4().hex[:8]}"
        pay = {"event_id": f"evt-{ref}", "event_type": "PAYMENT_POSTED", "customer_id": cid, "installment_id": inst["installment_id"],
               "payload": {"payment_ref": ref, "amount_cents": remaining, "currency": st0["loans"][0]["currency"]}}
        self.call("POST", "/v1/events", "agent", 403, json=pay)                       # un agente no puede registrar pagos
        r1 = self.call("POST", "/v1/events", "bank_simulator", 200, json=pay)
        r2 = self.call("POST", "/v1/events", "bank_simulator", 200, json=pay)         # mismo evento: idempotente
        r3 = self.call("POST", "/v1/events", "bank_simulator", 200, json=pay | {"event_id": f"evt2-{ref}"})  # mismo pago, otro evento
        assert r1["status"] == "PROCESSED" and r2["idempotent_replay"] and r3["status"] == "DUPLICATE"
        self.step(7, "Pago confirmado por el simulador bancario (idempotente)", referencia=ref, monto_cents=remaining,
                  agente_rechazado="403", reenvio_mismo_evento="replay", mismo_pago_otro_evento=r3["status"])

        # 8. Saldo actualizado
        st3 = self.state()
        inst_after = next(i for i in st3["installments"] if i["installment_id"] == inst["installment_id"])
        loan1 = st3["loans"][0]["outstanding_cents"]
        assert inst_after["status"] == "PAID" and inst_after["paid_cents"] == inst["amount_cents"]
        assert loan1 == loan0 - remaining, (loan0, remaining, loan1)
        assert st3["customer"]["case_version"] > st2["customer"]["case_version"]
        self.step(8, "Actualización del saldo", saldo_antes_cents=loan0, saldo_despues_cents=loan1,
                  cuota_estado=inst_after["status"], case_version=f"{v0} → {st3['customer']['case_version']}",
                  pagos_confirmados=len([p for p in st3["payments"] if p["status"] == "CONFIRMED" and p["kind"] == "PAYMENT"]))

        # 9. Decisiones obsoletas invalidadas
        dd = self.call("GET", f"/v1/decisions/{d2}", "reader")
        assert dd["validity"] == "stale" and dd["review_status"] == "pending"
        rej = self.call("POST", f"/v1/decisions/{d2}/review", "human", 409, json={"reviewer_id": "analista-demo", "action": "approve"})
        assert rej["detail"]["code"] == "STALE_CASE_VERSION"
        self.step(9, "Invalidación de decisiones obsoletas", decision=d2, validez=dd["validity"], motivo=dd["stale_reason"],
                  aprobar_obsoleta="409 STALE_CASE_VERSION")

        # 10. Cierre de la gestión de la cuota
        acts = [a for a in st3["scheduled_actions"] if a["installment_id"] == inst["installment_id"]]
        live = [a for a in acts if a["status"] in ("PENDING", "DUE", "BLOCKED")]
        assert not live, f"quedan acciones vivas de la cuota cerrada: {live}"
        assert inst_after["closed_at"]
        nxt_inst = st3["customer"]["current_installment"]
        self.step(10, "Cierre de la gestión de la cuota", cuota=inst["installment_id"], cerrada_en=inst_after["closed_at"],
                  acciones_de_la_cuota={a["action_id"]: a["status"] for a in acts},
                  siguiente_cuota=nxt_inst["installment_id"] if nxt_inst else None,
                  eventos_en_timeline=len(st3["events"]), corridas_de_agentes=len(st3["agent_runs"]))
        return self.report


def main():
    import httpx
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--customer", default="CLI-0003")
    ap.add_argument("--seed", action="store_true", help="carga clientes demo (requiere NEXO_ENABLE_DEV_SEED=1 en el servidor)")
    a = ap.parse_args()
    keys = keys_by_role()
    with httpx.Client(base_url=a.base_url, timeout=30) as http:
        if a.seed:
            http.post("/v1/dev/seed", headers={"X-Integration-Key": keys["system"]}).raise_for_status()
        Flow(http, keys, a.customer).run()
    print("\n✔ Flujo completo: los 10 pasos se ejecutaron y verificaron contra la BD.")


if __name__ == "__main__":
    sys.exit(main())
