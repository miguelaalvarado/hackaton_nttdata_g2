# AI Decision Engine — Cobranza temprana (MVP)

Módulo **independiente** (Python + FastAPI) que recibe datos **ficticios** de un cliente y un
**score de riesgo calculado externamente**, y devuelve una decisión explicable:

1. **Interpretación del riesgo basada en evidencia** (`app/interpreter.py`)
2. **Selección de estrategia preventiva** (`app/strategy.py`)
3. **Mensaje empático en borrador** (`app/messages.py`, plantillas, sin LLM)
4. **Supervisor de cumplimiento** (`app/compliance.py`) — toda acción exige aprobación humana

## Garantías (guardrails)
- **Sin envíos reales**: no hay código de salida (SMTP/HTTP/SMS). Toda respuesta incluye
  `delivery: {"sent": false, "mode": "draft_only"}`; un test verifica que no se importen librerías de envío.
- **Sin atributos sensibles**: edad, género, religión, etnia, nacionalidad, salud, estado civil, etc.
  se **rechazan con 422** en cualquier nivel del JSON (`app/sensitive.py`), y el supervisor bloquea
  mensajes que los mencionen. Además `extra="forbid"` rechaza cualquier campo no declarado.
- **Aprobación humana siempre**: `compliance.human_approval_required` es siempre `true`.
  Una decisión `blocked_needs_rewrite` no se puede aprobar (409).
- Datos solo ficticios; `customer_id` es un seudónimo.

## Ejecutar
```bash
cd ai_decision_engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
Docs interactivas: http://localhost:8000/docs · Contrato vivo: `GET /v1/contract`

Probar con un ejemplo:
```bash
curl -s -X POST localhost:8000/v1/decisions -H 'content-type: application/json' \
  -d @contracts/example_high_request.json | python3 -m json.tool
```

## Tests
```bash
pytest -q        # 49 tests: escenarios bajo/medio/alto, guardrails, límites de bandas, calendario/canales, propuestas de agente
```

## Contrato JSON
Fuente de verdad: `app/schemas.py`. Exportados en `contracts/`:
`decision_request.schema.json`, `decision_response.schema.json` y ejemplos
`example_{low,medium,high}_{request,response}.json`.
Regenerar: `python contracts/generate_contracts.py`. Versión actual: `1.0.0` (`contract_version` en la respuesta).

**Entrada** (`POST /v1/decisions`): `request_id`, `customer` (id seudónimo, nombre, idioma, canales con
consentimiento, canal preferido), `account` (producto, cuota, vencimiento, `days_past_due`, saldo),
`behavior` (pagos omitidos 6m, puntualidad, utilización, tendencia), `risk_score`
(`value` 0–100, mayor = más riesgo; `model_version`; `scored_at`), `local_hour` y/o `contact_at` (ISO con offset).

**Salida**: `decision_id`, `interpretation` (banda, confianza, evidencia citada, inconsistencias),
`strategy`, `message` (borrador), `compliance` (reglas C01–C08, violaciones), `delivery`, `review_status`.

> **Los umbrales 35 y 65 son ilustrativos** (supuestos de trabajo, no calibrados con datos). El score es
> externo y **no representa una probabilidad validada**; solo ordena riesgo relativo. Los límites están
> probados (34.99→low, 35→medium, 65→medium, 65.01→high) y la respuesta incluye `interpretation.score_note`.
> Calibrar y validar el modelo/umbrales queda a cargo de quien produce el score.

| Score | Banda | Estrategia |
|---|---|---|
| < 35 | low | `friendly_reminder` |
| 35–65 | medium | `proactive_support` |
| > 65 | high | `advisor_outreach` |

Si las señales conductuales contradicen el score, la confianza baja a `low` y se pide revisar el score.

## Endpoints
| Método | Ruta | Uso |
|---|---|---|
| POST | `/v1/decisions` | Genera la decisión con el motor de reglas (queda `pending`) |
| POST | `/v1/agent-proposals/evaluate` | Valida la propuesta estructurada de un agente de IA (queda `pending`) |
| GET | `/v1/decisions/{id}` | Consulta una decisión |
| POST | `/v1/decisions/{id}/review` | Humano aprueba/rechaza `{reviewer_id, action, comment}`. **No envía nada.** |
| GET | `/v1/contract` | JSON Schemas |
| GET | `/health` | Estado |

Almacenamiento en memoria (se pierde al reiniciar) — suficiente para el MVP.

## Cumplimiento por canal, calendario y zona horaria
Zona horaria única: **America/Lima** (UTC−5, sin horario de verano). `contact_at` debe traer offset y se
convierte a Lima (ej. `01:30Z` del día 4 = 20:30 del día 3 en Lima). Sin `contact_at` se usa `local_hour`
y no se evalúan reglas de día.

| Regla | Aplica a | Criterio |
|---|---|---|
| C01 | todos | canal con consentimiento del cliente |
| C02 | todos | 08:00 ≤ hora < 20:00 (política interna conservadora) |
| C09 | `phone_call`, `in_person_visit` | solo lunes a viernes (sábado y domingo bloqueados) |
| C10 | `phone_call`, `in_person_visit` | no en feriado (`app/calendar_pe.py`) |
| C03–C06 | todos | sin presión, sin atributos sensibles, sin promesas, con opt-out |
| C11 | propuestas de agente | racional y ofertas sin presión/promesas/atributos sensibles |

Canales digitales (`sms`, `email`, `whatsapp`, `push`) no se restringen por día, solo por horario.
**Pendiente de Legal/Cumplimiento:** validar horarios y días contra la normativa vigente y la lista de
feriados (es aproximada y conservadora; no incluye "días no laborables" decretados ad hoc). El 08:00–20:00
es política interna, no una cita legal.

## Integración con agentes de IA
Este módulo **no contiene agentes, LLM ni orquestación** (para no duplicar lo que construyen otros).
Expone una puerta de validación: `POST /v1/agent-proposals/evaluate`.

```
Agente de IA (otro componente) ──propuesta estructurada──▶ /v1/agent-proposals/evaluate
   {proposal_id, agent_id, context: <DecisionRequest>, proposal: {strategy_code, channel, contact_at, subject?, body, offers[], rationale}}
                                                           │ interpreta riesgo (evidencia propia) + valida C01–C11
                                                           ▼
   DecisionResponse {source:"agent_proposal", baseline_strategy, alignment_notes, compliance, interpretation...}
                                                           ▼
                      Revisor humano ──▶ POST /v1/decisions/{id}/review   (nada se envía)
```
- Si la estrategia del agente difiere de la sugerida por la banda, se informa en `alignment_notes`
  (no se oculta ni se corrige automáticamente).
- Una propuesta con violaciones queda `blocked_needs_rewrite`: el agente debe reformular y reenviar.
- Esquema: `contracts/agent_proposal_request.schema.json`; ejemplo: `contracts/example_agent_proposal_*.json`.
- Las decisiones de agentes y del motor de reglas comparten almacén, formato y flujo de revisión.

## Integración con frontend
1. Configura CORS: `CORS_ORIGINS="http://localhost:5173" uvicorn app.main:app --port 8000`
   (por defecto permite `localhost:5173` y `localhost:3000`).
2. Flujo de pantalla: **score externo → POST /v1/decisions → mostrar evidencia, estrategia y borrador →
   revisor humano aprueba/rechaza → POST .../review**. La ejecución real del envío queda fuera de este módulo.
3. Mostrar siempre `compliance.violations` y deshabilitar "Aprobar" si `status === "blocked_needs_rewrite"`.

```ts
const API = "http://localhost:8000";

export async function createDecision(payload) {
  const r = await fetch(`${API}/v1/decisions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (r.status === 422) throw new Error("Entrada inválida o con atributos sensibles");
  if (!r.ok) throw new Error(`Error ${r.status}`);
  return r.json(); // DecisionResponse
}

export async function review(decisionId, reviewerId, action, comment = "") {
  const r = await fetch(`${API}/v1/decisions/${decisionId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewer_id: reviewerId, action, comment }),
  });
  if (r.status === 409) throw new Error("Decisión bloqueada o ya revisada");
  return r.json();
}
```
Para propuestas de agente el frontend consume el mismo `DecisionResponse` (`source === "agent_proposal"`).
Tipos TS: genera desde los schemas, p. ej. `npx json-schema-to-typescript contracts/decision_response.schema.json`.

## Estructura
```
ai_decision_engine/
  app/{schemas,sensitive,interpreter,strategy,messages,compliance,main}.py
  contracts/   schemas + ejemplos + generador
  tests/       escenarios y guardrails
```

## Límites del MVP
Reglas y plantillas deterministas (auditables); sin LLM, sin persistencia, sin autenticación.
Ventana de contacto (08:00–20:00) y umbrales de banda son supuestos configurables en código.


---
## Persistencia, eventos y seguimiento (v1.2.0)

**SQLite local** (`data/nexo.db`, variable `NEXO_DB_PATH`) como única fuente de verdad. Importes en **centavos enteros**,
timestamps ISO-8601 UTC, claves foráneas activas, cada cambio relevante en una **transacción** con traza.

| Módulo | Rol |
|---|---|
| `app/db.py` | conexión, esquema, migración mínima (`schema_migrations`) |
| `app/repositories.py` | capa de repositorios (único lugar con SQL) |
| `app/events.py` | motor de eventos idempotentes (`POST /v1/events`) |
| `app/scheduling.py` | Follow-up & Scheduling Engine: próxima acción permitida, `tick`, ejecución **simulada** con revalidación |
| `app/decision_service.py` | decisiones persistidas + revisión humana con control de `case_version` |
| `app/seed.py`, `app/demo_agent.py` | datos ficticios y agente demo (sin LLM) |
| `dashboard/streamlit_app.py` | dashboard local sobre la BD real |

**Reglas clave**
- Un pago solo existe tras `PAYMENT_POSTED` con `source=bank_simulator`; el mismo `event_id` o `payment_ref` jamás se cuenta dos veces.
- `PAYMENT_PENDING` no descuenta dinero y bloquea acciones/aprobaciones; `PAYMENT_REVERSED` genera asiento compensatorio y reevalúa.
- Una promesa **no** es un pago. Opt-out cancela acciones del canal; una disputa bloquea la cobranza hasta `HUMAN_REVIEW`.
- Todo cambio de saldo/compromiso/estado sube `case_version` e invalida propuestas pendientes. Aprobar una decisión con versión
  obsoleta → **409 `STALE_CASE_VERSION`** (el contrato `1.2.0` agrega `case_version` opcional a la solicitud y `case_version/validity` a la decisión; es aditivo).
- Intervalos mínimos, tope semanal y ventana horaria viven en `policy_config` (`GET/PUT /v1/policy`): **supuestos de trabajo auditables, no reglas legales**. Cada acción guarda el snapshot de política aplicado.
- Nada se envía: ejecutar una acción solo registra un contacto `SIMULATED_SENT`.

**Endpoints nuevos**: `POST /v1/events`, `GET /v1/customers[/{id}]`, `GET /v1/customers/needs-reevaluation`,
`POST /v1/customers/{id}/reevaluate`, `GET /v1/scheduled-actions?status=`, `POST /v1/scheduled-actions/{id}/execute`,
`POST /v1/scheduler/tick`, `GET/PUT /v1/policy`, `GET /v1/agent-runs`, `POST /v1/dev/seed`.

**Dashboard**: `streamlit run dashboard/streamlit_app.py` (usa la misma BD; `NEXO_DB_PATH` para cambiarla).

## Seguridad (frontera HTTP)

- **Credenciales**: cabecera `X-Integration-Key`; mapa `clave → rol` solo en el entorno (`NEXO_INTEGRATION_KEYS`). Ver `.env.example`.
  Generar: `python3 -c "import secrets;print(secrets.token_urlsafe(32))"`. Nunca en código, logs ni GitHub (`.env` está ignorado).
- **Fail-closed**: sin claves, JSON inválido o clave incorrecta → 401. Clave válida sin permiso → 403. Ambos **sin escribir en la BD**.
- **Roles**: `human`, `bank_simulator`, `customer_channel`, `agent`, `system`, `reader` (+ `untrusted` = sin credencial: no puede nada).
- **El rol sale de la credencial, no del cuerpo**. Un `source` declarado que no coincide → 403 `SOURCE_MISMATCH`.
- **Una sola lógica de revisión**: `decision_service.review_in_tx` (rol humano, cumplimiento, `review_status`, `case_version`, disputa,
  pago pendiente) la usan `POST /v1/decisions/{id}/review`, `POST /v1/events` (`HUMAN_REVIEW`) y el dashboard.
- **Lectura protegida**: todo `GET` con datos de expedientes exige rol `human|agent|system|reader`. Públicos: `/health`, `/v1/contract`
  (solo esquemas), `/docs` y `/openapi.json` (solo esquemas). `POST /v1/dev/seed` está apagado salvo `NEXO_ENABLE_DEV_SEED=1`.
- **Dashboard local (frontera distinta)**: `dashboard/streamlit_app.py` NO pasa por HTTP ni por `X-Integration-Key`; llama a los servicios
  en proceso y actúa como consola humana de confianza (puede simular pagos del banco y aprobar). Por eso `.streamlit/config.toml` lo
  ata a `127.0.0.1`. **No exponerlo a la red ni publicarlo**: quien lo alcance tiene todos los roles. Para producción se reemplaza
  por un frontend que consuma la API con credenciales por usuario.

### Límites conocidos (MVP)
- Las claves son secretos compartidos por integración: no identifican a la persona revisora (`reviewer_id` lo declara el cliente) y no hay
  expiración, rotación automática, firma HMAC, TLS ni límite de tasa. Pónganse detrás de HTTPS y un proxy antes de publicar.
- `bank_simulator` es un rol, no un banco: quien tenga esa clave puede registrar pagos ficticios.
- Los intentos denegados solo se registran en el log del proceso (rol y motivo, sin payload ni claves), no en la BD.
- Los eventos rechazados por reglas de negocio (autorizados pero inválidos) sí quedan auditados en `events`.

Contrato para agentes y frontend: [`docs/INTEGRATION_CONTRACT.md`](docs/INTEGRATION_CONTRACT.md).

## Orquestador y flujo de demostración (10 pasos)

`app/orchestrator.py` coordina los componentes reutilizando los módulos existentes (`interpreter`, `strategy`, `messages`,
`scheduling`, AI Decision Engine). Hoy son deterministas (sin LLM) tras una interfaz estable; cada uno lee la BD y deja su corrida
en `agent_runs` (`trigger = orchestrator:<id>`). Un LLM puede sustituirlos sin privilegios nuevos: toda propuesta pasa por
`evaluate_agent_proposal` y por revisión humana, y nadie salvo `bank_simulator` registra pagos.

| Componente | Implementación |
|---|---|
| 0 Orchestrator | `propose_case` (`POST /v1/orchestrator/run`) |
| 1 Risk | `interpreter.interpret` |
| 2 Strategy | `strategy.select_strategy` |
| 3 Contact | `scheduling.plan_next_action` (consentimiento, exclusiones, frecuencia, ventana) |
| 4 Conversational | `messages.draft_message` + última respuesta del cliente |
| 5 Negotiation | ofertas condicionadas ("sujetas a evaluación"), sin montos |
| 6 Compliance | AI Decision Engine (`compliance.review`) vía `evaluate_agent_proposal` |
| 7 Follow-up & Learning | `followup_agent` (`POST /v1/orchestrator/followup/{id}`) |

Demo local (claves efímeras, no se imprimen):
```bash
export NEXO_ENABLE_DEV_SEED=1 NEXO_INTEGRATION_KEYS="$(python3 - <<'PY'
import json,secrets
print(json.dumps({secrets.token_urlsafe(24):r for r in ["human","bank_simulator","agent","system","reader","customer_channel"]}))
PY
)"
uvicorn app.main:app --port 8000 &
python3 -m scripts.demo_flow --base-url http://localhost:8000 --customer CLI-0003 --seed
```
Hace los 10 pasos: consulta BD → riesgo → estrategia/contacto → validación → aprobación humana → gestión y próximo seguimiento →
pago confirmado (idempotente) → saldo actualizado → decisión obsoleta invalidada (409) → cierre de la cuota. Cada paso verifica la BD vía API.

**Si se integra Next.js**: usar Backend-for-Frontend; claves solo en el servidor (sin `NEXT_PUBLIC_`), adjuntar `X-Integration-Key`
en rutas servidor, autenticar y autorizar al usuario antes de permitir revisión humana, y no publicar la API sin HTTPS.
