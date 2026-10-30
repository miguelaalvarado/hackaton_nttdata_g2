# CLAUDE.md — Acompaña (prevención del abandono en becarios Beca 18 / Pronabec)

> Nombre de trabajo: **Acompaña**. El código del producto vive en `acompana/`.
> `web/`, `src/`, `models/`, `CONTEXT.md` y `PLAN.md` en la raíz pertenecen a un proyecto anterior (cobranza temprana B3).
> **No modificarlos ni reutilizar su lógica de negocio** salvo que el equipo lo pida.

## 1. Producto

**Problema.** Los becarios (muchos migrantes que viven solos) abandonan o pierden la beca no por falta de talento, sino porque en los
primeros meses se acumulan presiones académicas, emocionales, vocacionales y económicas que nadie detecta a tiempo.
**Tramo crítico:** desde la adjudicación de la beca hasta el fin del primer ciclo.

**Propuesta.** Detectar señales temprano, convertirlas en un perfil y una alerta con responsable, y acompañar al becario con un asistente
(IA) que propone siguientes pasos concretos. Hilo de la demo: **señal → alerta → perfil → acción humana → seguimiento**.

### Roles (control de acceso por rol)
| Rol | Ve / hace |
|---|---|
| `BECARIO` | Su onboarding, kit de llegada, plan, avance frente a reglas de su cohorte, asistente, consentimientos, autorización a familia |
| `MENTOR` | Becarios asignados, registro de sesiones, alertas de integración que se le asignen |
| `TUTOR` (tutor/psicólogo) | Alertas académicas o emocionales asignadas, casos escalados por crisis, notas de seguimiento |
| `COORDINADOR` (universidad o Pronabec) | Panel: becarios por color y perfil, razones, alertas abiertas, cumplimiento 48 h, métricas; asignación de responsables |

Un coordinador de universidad solo ve becarios de su universidad; uno de Pronabec ve todos. La autorización se valida **en la API**, nunca solo en la UI.

## 2. Reglas de negocio

### 2.1 Reglas de la beca — siempre configurables (tabla `RuleSet`), nunca fijas en el código
Fuente normativa: DS 017-2026-MINEDU (publicado en El Peruano, sept. 2026). Antes de la demo, contrastar con el texto oficial.
- Todos los becarios: promedio ponderado aprobatorio por periodo, matrícula en los créditos previstos y alcanzar el tercio superior.
- Cohorte `NUEVO_DS017` (adjudicados desde la vigencia del decreto): pierde la beca si desaprueba **dos veces** el mismo curso o cursos distintos.
- Cohorte `PRE_DS017` (adjudicados antes): esa causal **no aplica**.
- El código evalúa reglas leyendo el `RuleSet` de la cohorte (umbral de nota, créditos, tercio superior, límite de desaprobaciones, si la causal aplica).
  Prohibido escribir `if (cohort === ...)` con números mágicos.

### 2.2 Semáforo de riesgo (verde / amarillo / rojo)
- Variables permitidas: asistencia, conexión (actividad en plataforma/LMS), notas parciales, cursos desaprobados, horas de estudio vs meta, ánimo.
- **Prohibido** usar región de origen, lengua o pobreza como causa directa (ni como variable del modelo ni como razón mostrada).
  Pueden usarse solo para asignar mentores o adaptar el kit de llegada.
- MVP: reglas duras + regresión logística entrenada con datos sintéticos (coeficientes versionados en JSON). Umbrales de color configurables.
- Siempre se muestran las **3 razones principales** (contribución de cada variable + reglas disparadas), en lenguaje claro.
- Reglas duras que fuerzan rojo: becario `NUEVO_DS017` con ≥1 curso desaprobado; perfil `MALESTAR_EMOCIONAL` con señal de crisis.

### 2.3 Siete perfiles combinables (recalculados cada semana)
`ESTABLE`, `BARRERA_ACADEMICA`, `TIEMPO_RECURSOS`, `INTEGRACION`, `MOTIVACION_VOCACION`, `MALESTAR_EMOCIONAL`, `EVENTO_VIDA`.
- Un becario puede tener varios a la vez (`ESTABLE` es excluyente con los demás).
- Cada perfil activa una respuesta distinta (playbook): responsable, tipo de acción y mensaje al becario.
- **Prioridad:** `MALESTAR_EMOCIONAL` y `EVENTO_VIDA` se atienden primero.
- Becario nuevo con un curso desaprobado → alerta **roja**.
- `TIEMPO_RECURSOS` **nunca** reduce créditos por su cuenta: solo sugiere hablar con el tutor/coordinador (reducir créditos puede incumplir la regla de matrícula).

### 2.4 Alertas en dos direcciones
- Al becario: siempre con un **siguiente paso concreto**; tono de acompañamiento, nunca regaño.
- Al equipo: siempre con **responsable asignado**.
- Toda alerta roja tiene vencimiento a las **48 h**. "Atendida" = primera acción humana registrada. Se guarda si se cumplió (`slaMet`).

### 2.5 Asistente con IA
- Detrás de la interfaz `LLMProvider` (implementaciones: Anthropic API, Amazon Bedrock, y `MockProvider` determinista para demo sin clave).
- Funciones: acompañar, recordar clases, pastillas motivacionales sobre los temas de la semana, dudas de trámites, check-in semanal de ánimo.
- Si no se cumple una meta: propone un siguiente paso concreto; nunca regaña.
- **Alcance limitado** a estudios, trámites y bienestar. Ante temas ajenos, redirige con amabilidad. No es un chatbot general.
- **Crisis:** la detección corre **antes** del LLM. Si hay lenguaje de crisis, el asistente no responde por su cuenta: escala de inmediato a un
  humano (alerta roja al tutor/psicólogo) y muestra la línea de ayuda configurable (`config.crisisHelpline`).

### 2.6 Consentimiento y datos personales (Ley 29733)
- Consentimientos explícitos y separados: tratamiento de datos y mensajes por WhatsApp. Se guarda **fecha, versión y texto exacto aceptado**.
- Revocar es tan fácil como aceptar. El puente con la familia requiere autorización explícita del becario y se puede retirar.
- Solo datos sintéticos en el repo. Ningún dato personal real. Credenciales solo en variables de entorno (`.env` fuera de git).

### 2.7 Canal WhatsApp (cumplimiento obligatorio)
- Solo API oficial: WhatsApp Cloud API (Meta) o AWS End User Messaging Social, detrás de `MessagingChannel`.
  **Prohibido** cualquier librería que automatice WhatsApp Web (whatsapp-web.js, Baileys, venom, etc.).
- `SimulatorChannel` implementa la misma interfaz para la demo.
- Envío solo con opt-in vigente. La palabra **BAJA** (sin distinguir mayúsculas/tildes/espacios) revoca el opt-in de inmediato y se confirma una sola vez.
- Ventana de atención de 24 h por becario (desde su último mensaje entrante): dentro, mensajes libres; fuera, solo plantillas aprobadas.
- Catálogo de plantillas en código con categoría `UTILITY` o `MARKETING`. Recordatorios ligados a una clase o trámite concreto = `UTILITY`.
  Nada promocional disfrazado de utility (las pastillas motivacionales son `MARKETING` si van fuera de la ventana).
- Límite de frecuencia configurable (por defecto 1 mensaje **iniciado por la plataforma** al día por becario) y silencio de **22:00 a 07:00, America/Lima**.
- Los check-ins terminan con una pregunta (para que la respuesta reabra la ventana).
- Webhooks: estados `sent`, `delivered`, `read`, `failed`. Registrar errores de límite y calidad; alertar al coordinador si superan un umbral.
- Cola con reintentos y backoff exponencial solo para errores transitorios. **Nunca reintentar** un mensaje rechazado por política
  (fuera de ventana, sin opt-in, plantilla rechazada, etc.).
- Todo envío pasa por una única puerta de políticas (`policyGate`) en `packages/domain`; ningún adaptador envía sin pasar por ella.

## 3. Arquitectura y stack
- TypeScript en todo. Monorepo con npm workspaces en `acompana/`.
- `apps/web`: Next.js (App Router) — vista móvil del becario, simulador de chat, panel de coordinador/tutor/mentor.
- `apps/api`: Node (Fastify) — REST, autenticación demo por rol (JWT), webhooks, recalculo semanal.
- `apps/worker`: proceso de cola (pg-boss sobre PostgreSQL) para envíos, reintentos y tareas programadas.
- `packages/domain`: lógica pura y testeable (reglas de beca, semáforo, perfiles, alertas, políticas de mensajería, detección de crisis). Sin I/O.
- `packages/db`: Prisma (schema, migraciones, seed sintético) y **servicios de aplicación** en `src/services`
  (recálculo, alertas, conversación, envío). Los usan API, worker y seed.
- `packages/llm`: `LLMProvider` + adaptadores. `packages/messaging`: `MessagingChannel` + adaptadores + catálogo de plantillas.
- PostgreSQL. `docker compose up` levanta todo. Infra AWS preparada en `acompana/infra/` (no requerida para la demo).

### Comandos (desde `acompana/`)
- Demo completa: `docker compose up --build` (web :3000, API :4000).
- Desarrollo: `npm install`, `npm run db:migrate`, `npm run db:seed`, `npm run dev:api|dev:worker|dev:web`.
- Calidad: `npm test` y `npm run typecheck`. Reentrenar el modelo sintético: `npm run train` (actualiza `risk/model.json`).
- Versión navegador (sin servidor, publicada como página en claude.ai): `apps/web/browser-demo/`. Su `backend.ts` replica las rutas de
  la API en memoria usando `packages/domain`; si cambias rutas, servicios o pantallas, actualízalo también. Regenerar:
  `npm run db:seed && npm run export:snapshot -w @acompana/db && npm run build:browser -w @acompana/web`.

## 4. Convenciones
- Código (identificadores) en inglés; textos de UI, mensajes al becario y documentación en español (Perú), trato de "tú", tono cálido y claro.
- Lógica de negocio solo en `packages/domain` como funciones puras; las apps orquestan e inyectan dependencias (puertos/adaptadores).
- Fechas en UTC en BD; conversión a `America/Lima` solo en bordes (UI, horario de silencio, semanas).
- Validación de entradas con Zod en la API. Errores con códigos estables.
- Pruebas con Vitest. Obligatorias: reglas de beca, semáforo, perfiles, ventana 24 h, opt-in/opt-out (BAJA), límite de frecuencia y horario de silencio.
  `npm test` en `acompana/` después de cada etapa; no avanzar con pruebas en rojo.
- Commits en español, estilo convencional (`feat(domain): ...`). Nunca subir `.env`, claves ni datos reales.
- Sin dependencias nuevas sin justificar. Sin librerías no oficiales de WhatsApp.
- No inventar normativa: si una regla no está en esta guía o en el `RuleSet`, preguntar al equipo.

## 5. Demo (3 becarios ficticios)
- **Ana** — estable (verde).
- **Luis** — migrante, vive solo, cohorte nueva, un curso desaprobado → `INTEGRACION` + `BARRERA_ACADEMICA`, rojo, mentor + tutor.
- **Rosa** — check-in con lenguaje de malestar → `MALESTAR_EMOCIONAL`, escala a psicólogo, línea de ayuda, seguimiento con SLA 48 h.

## 6. Etapas
1. Demo: onboarding, kit, plan, asistente en simulador, semáforo, perfiles, alertas, panel.
2. WhatsApp real: plantillas, webhooks, cola con reintentos.
3. Mentores, puente con familia y métricas completas.
