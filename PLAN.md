# Plan de trabajo — B3 Cobranza temprana (≈5 h, deploy en Vercel)

Restricciones: ~5 horas, solución simple pero funcional, desplegada en Vercel. Criterios (20 % c/u): ejecución en vivo, aplicación práctica, UX, innovación, uso de agentes de IA inmerso (en la diapositiva aparece como «Propuesta técnica»). Hay un **reconocimiento opcional NANDA** para quien muestre la mejor aplicación de NANDA.

## Restricción técnica que decide el diseño
Vercel no es buen sitio para correr sklearn. Por eso **el modelo se entrena offline (ya hecho: `models/pd_gmsc.joblib`, AUC 0.868) y se exporta a JSON**: una cartera demo de ~200-300 clientes con su PD, señales y razones. La app solo lee ese JSON y llama a un LLM. Cero ML en runtime, cero base de datos.

## Opción A (la de CONTEXT.md): copiloto de cartera con bandit
Cartera → caso → recomendación → simulador de respuesta → bandit que aprende → gráfico "genérica vs adaptativa".
- Pros: potente en aplicación práctica (impacto en cartera), cuenta una historia de negocio.
- Contras: más piezas (simulador de series, bandit, comparativa); mucho riesgo para 5 h.

## Opción B (recomendada): «Negociador de cobranza» — dos agentes que conversan
Idea: el agente de cobranza **conversa con un cliente simulado (otro agente con una persona)** y adapta canal, oferta y tono según lo que el cliente responde. Un tercer agente (cumplimiento) audita cada mensaje antes de enviarlo. El gestor humano ve todo el razonamiento y aprueba.

```
Gestor elige cliente de la cartera (tabla ordenada por PD)
        │
        ▼
 Agente Cobranza (LLM + tools, multi-paso)
   tools: get_client, get_signals, get_pd_and_reasons,
          channel_options (costo/efectividad), expected_loss,
          past_contacts, propose_contact
        │  propone: canal + oferta + mensaje + costo vs pérdida evitada
        ▼
 Agente Cumplimiento (reglas + LLM): horario, tono, nº de contactos, lenguaje
        │  aprueba / corrige / bloquea
        ▼
 Gestor: aprobar / editar  ──►  Agente Cliente simulado (persona según perfil)
        │                          responde: "no puedo pagar", "me olvidé", ...
        ▼
 Agente Cobranza REPLANIFICA (cambia canal/oferta) y lo explica
```

Por qué encaja con los criterios:
| Criterio | Cómo |
|---|---|
| Ejecución | Un solo flujo corto, datos precalculados, sin dependencias frágiles; el LLM es lo único en vivo |
| Aplicación práctica | Usuario = gestor de cobranza; muestra costo del canal vs pérdida esperada y reglas de conducta |
| UX | Tabla de cartera → panel de caso con el "trace" de herramientas visible → chat de la negociación |
| Innovación | Dos agentes conversando + replanificación según respuesta; no es "modelo + chatbot" |
| IA inmersa | El agente decide con tools y se corrige; el modelo de PD es una herramienta suya |
| NANDA (opcional) | Ver abajo |

### Ángulo NANDA (opcional, solo si sobra tiempo)
Exponer los agentes (Cobranza, Cumplimiento) como servicios independientes con una "tarjeta de agente" (`/.well-known/agent.json` con nombre, capacidades, endpoint) y hacer que Cobranza descubra y llame a Cumplimiento a través de esa tarjeta, en vez de una función interna. **No verifiqué la especificación exacta de NANDA**: preguntar a los organizadores o revisar su documentación antes de invertir tiempo; si cuesta más de 30 min, se descarta.

## Stack mínimo
- **Next.js (App Router) en Vercel** + **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`) con tool-calling y streaming.
- Modelo rápido y barato para latencia (p. ej. Haiku) y uno más capaz solo para el agente de cobranza si hace falta.
- Datos: `public/portfolio.json` generado por `src/export_demo.py` (nuevo). Variable de entorno `ANTHROPIC_API_KEY` en Vercel (no en el repo).
- UI: Tailwind; sin librería de gráficos pesada (una barra de PD y un par de números bastan).

## Cronograma (5 h)
| Hora | Bloque | Entregable / criterio de listo |
|---|---|---|
| 0:00-0:30 | Export de datos | `export_demo.py`: 250 clientes de GMSC con PD (modelo ya entrenado), 3 razones principales por cliente y 12 semanas de señales sintéticas (uso de línea, pagos mínimos, frecuencia). JSON < 1 MB. Declarar que las series son sintéticas |
| 0:30-1:00 | Esqueleto Next.js + deploy | `vercel` desplegado con la tabla de cartera leyendo el JSON. **Deploy vacío funcionando desde el minuto 60** |
| 1:00-2:30 | Agente de cobranza | Ruta `/api/agent` con tools sobre el JSON, streaming del trace, salida estructurada (canal, oferta, mensaje, costo vs pérdida evitada). Tabla de costos por canal como constantes editables (supuestos, no datos) |
| 2:30-3:15 | Cumplimiento + aprobación | Reglas determinísticas (horario, máx. contactos/semana, palabras prohibidas) + una pasada de LLM; botones aprobar/editar |
| 3:15-4:00 | Cliente simulado + replanificación | Persona del cliente según su perfil; el agente cambia de táctica tras la respuesta |
| 4:00-4:30 | Pulido de UX | Estados de carga, el trace legible, un caso de ejemplo ya cargado |
| 4:30-5:00 | Ensayo y respaldo | Guion de 3 min, 2 casos precomputados por si falla la red, grabar un video de respaldo |

**Regla:** si a las 3:00 el flujo base (elegir cliente → recomendación → aprobar) no es estable, no se hace el cliente simulado ni NANDA.

## Guion de demo (3 min)
1. Problema en una frase y la tabla de cartera (PD real de GMSC).
2. Cliente de alto riesgo → el agente razona a la vista: señales, PD, costo del canal vs pérdida esperada.
3. Cumplimiento corrige un mensaje (se ve el cambio).
4. Gestor aprueba → el cliente responde "no puedo pagar este mes" → el agente cambia de llamada a plan de pago por WhatsApp y explica por qué.
5. Cierre: qué es real (modelo, datos de GMSC) y qué es simulado (series semanales, respuestas, costos).

## Riesgos y mitigaciones
- **Latencia del LLM:** modelo rápido, streaming y 2 casos precomputados de respaldo.
- **Alucinación de cifras:** el agente solo cita números que devuelven las tools.
- **Honestidad con los datos:** series, respuestas y costos son sintéticos; decirlo en pantalla.
- **Clave API:** solo como variable de entorno en Vercel; no commitear `.env`.
- **Alcance:** nada de bandit ni comparativa de cartera (eso es la Opción A, para después).

## Hecho hasta ahora
- Entorno `uv`, Kaggle autenticado, datasets descargados en `data/`.
- `src/train_pd.py` y `models/pd_gmsc.joblib`: AUC 0.868, recall del top 10 % = 55 %, calibrado.
- Pendiente inmediato: `src/export_demo.py` y el esqueleto Next.js.
