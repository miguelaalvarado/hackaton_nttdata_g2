# Contrato de integración — agentes y frontend (v1.2.0)

Base: `http://localhost:8000`. Todo es JSON. Datos ficticios; **la API nunca envía mensajes**.
Auth: cabecera `X-Integration-Key: <clave>` (la clave define el rol; ver README → Seguridad).
Errores de auth: `401 {"detail":{"code":"UNAUTHENTICATED"}}` · `403 {"detail":{"code":"FORBIDDEN_ROLE"|"SOURCE_MISMATCH"}}`.

## 1. Matriz de permisos
| Operación | human | bank_simulator | customer_channel | agent | system | reader |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Leer (`GET` clientes, acciones, runs, política, decisión) | ✔ | ✘ | ✘ | ✔ | ✔ | ✔ |
| Proponer: `POST /v1/agent-proposals/evaluate`, `POST /v1/decisions` | ✔ | ✘ | ✘ | ✔ | ✔ | ✘ |
| Aprobar/rechazar: `POST /v1/decisions/{id}/review` o evento `HUMAN_REVIEW` | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Eventos `PAYMENT_POSTED` / `PAYMENT_PENDING` / `PAYMENT_REVERSED` | ✘ | ✔ | ✘ | ✘ | ✘ | ✘ |
| `CUSTOMER_REPLIED`, `PROMISE_CREATED`, `CONTACT_OPT_OUT`, `DISPUTE_OPENED` | ✔ | ✘ | ✔ | ✔ | ✔ | ✘ |
| `PROMISE_DUE`, `CONTACT_RECORDED`, `INVESTIGATE` | ✔ | ✘ | ✘ | ✔ | ✔ | ✘ |
| Operar: `scheduler/tick`, `reevaluate`, `execute` (simulado), `PUT /v1/policy` | ✔ | ✘ | ✘ | ✘ | ✔ | ✘ |

Regla de oro: **un agente (LLM) solo propone**. No puede registrar pagos, tocar saldos ni aprobar. Un agente tampoco puede declararse otro rol: el rol sale de su clave.

## 2. Flujo de un agente
1. `GET /v1/customers/{id}` → estado vigente (saldo, cuotas, pagos, contactos, promesas, acciones, `case_version`).
2. Decide y envía `POST /v1/agent-proposals/evaluate` con `context.case_version` = la versión leída (recomendado) y `proposal` (estrategia, canal, `contact_at` con offset, `body` con instrucción BAJA/STOP).
3. Respuesta `201` = `DecisionResponse` con `compliance.status` (`pending_human_approval` | `blocked_needs_rewrite`), `case_version`, `validity` (`valid`|`stale`), `alignment_notes`.
4. Si `validity=stale` o más tarde cambia el expediente → la propuesta ya no es aprobable: **volver a leer y reevaluar** (consultar `GET /v1/customers/needs-reevaluation`).
5. Informa hechos del mundo con `POST /v1/events` (solo los tipos permitidos a su rol).

Cada corrida queda en `agent_runs` (`GET /v1/agent-runs?customer_id=`); los agentes no necesitan escribirla para las llamadas de arriba.

## 3. Eventos — `POST /v1/events`
```json
{ "event_id": "uuid-único", "event_type": "PROMISE_CREATED", "customer_id": "CLI-0002",
  "installment_id": "IN-0002-1", "occurred_at": "2026-10-19T10:00:00-05:00",
  "payload": { "amount_cents": 50000, "promised_date": "2026-10-25" } }
```
- `source` NO se envía (si se envía debe coincidir con el rol de la clave).
- Idempotente por `event_id` (`idempotent_replay: true`); un `payment_ref` repetido → `status: DUPLICATE`.
- `200` `{event_id,status,case_version,trace,idempotent_replay}` · `422` negocio (auditado) · `404/409` estado.

| Tipo | `payload` |
|---|---|
| PAYMENT_POSTED / PAYMENT_PENDING | `payment_ref`, `amount_cents` (entero) ó `amount` (string "100.10"), `currency`, (`bank_status`="CONFIRMED") |
| PAYMENT_REVERSED | `payment_ref` |
| CUSTOMER_REPLIED | `text`, `channel`, (`thread_id`) — `BAJA`/`STOP` activa la exclusión |
| PROMISE_CREATED | `amount_cents`, `promised_date` (YYYY-MM-DD) — no es un pago |
| PROMISE_DUE | `promise_id` |
| CONTACT_RECORDED | `channel`, `outcome` (DELIVERED, NO_RESPONSE, FAILED…), (`direction`, `action_id`, `decision_id`) |
| CONTACT_OPT_OUT | `channels: [..]` ó `all: true` |
| DISPUTE_OPENED | `reason` |
| HUMAN_REVIEW | `kind`: `decision_review` (`decision_id`,`reviewer_id`,`action`,`comment`) ó `resolve_dispute` (`reviewer_id`) |
| INVESTIGATE | `reason` |

Importes: **siempre centavos enteros** en la BD y en `*_cents`. Fechas/horas: ISO‑8601 con offset; la BD guarda UTC.

## 4. Revisión humana
`POST /v1/decisions/{id}/review` `{reviewer_id, action: approve|reject, comment}` con clave `human`.
| Código | Significado |
|---|---|
| 200 | registrada; si se aprobó, el motor programa/vincula una acción (`scheduled_action_id` interno) |
| 401/403 | sin credencial / rol no humano |
| 404 | decisión inexistente |
| 409 `STALE_CASE_VERSION` | el expediente cambió: reevaluar (`decision_case_version` vs `current_case_version`) |
| 409 `DISPUTE_OPEN` / `PAYMENT_PENDING` | cobranza suspendida / pago por verificar |
| 409 | bloqueada por cumplimiento, o ya `approved`/`rejected` |

## 5. Lecturas para el frontend
| Ruta | Contenido |
|---|---|
| `GET /v1/customers` | resumen por cliente: saldo, cuota abierta, `next_action`, `case_version`, flags `needs_reevaluation`, `dispute_open`, `opted_out_all`, `pending_decisions` |
| `GET /v1/customers/{id}` | `customer, loans, installments, payments, contact_history, conversations, promises, decisions, scheduled_actions, events (timeline), agent_runs` |
| `GET /v1/scheduled-actions?status=&customer_id=` | agenda (PENDING, DUE, COMPLETED, CANCELLED, BLOCKED, EXPIRED) con `reason`, `status_reason`, `responsible_agent`, `policy_json` |
| `GET /v1/customers/needs-reevaluation` | clientes que requieren nueva evaluación + motivo |
| `GET /v1/agent-runs`, `GET /v1/policy`, `GET /v1/decisions/{id}` | trazas, política vigente, decisión persistida |

Para publicar el frontend: nunca incrustar claves en el bundle del navegador; usar un backend‑for‑frontend o sesión por usuario que añada la cabecera.

## 6. Esquemas
`GET /v1/contract` (público, solo esquemas) y `contracts/*.schema.json`. Cambios 1.2.0 (aditivos): `DecisionRequest.case_version`, `DecisionResponse.case_version|validity|stale_reason`.
