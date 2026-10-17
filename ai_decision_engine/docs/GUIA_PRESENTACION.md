# Guía de presentación · NEXO AI Demo Arena (≈ 2 minutos)

**Antes de empezar (1 min, fuera de cámara)**
```bash
cd ~/hackaton_nttdata_g2/ai_decision_engine && source .venv/bin/activate
python3 -m scripts.check_openai        # solo si quieren mostrar IA real (requiere .env con su clave)
streamlit run dashboard/streamlit_app.py   # abre http://localhost:8501
```
En **Portafolio** pulsa *Cargar clientes demo* (con la casilla de confirmación) si la base está vacía. Proyecta con el navegador al 110–125 %.

| # | Qué haces | Qué dices | Qué prueba la pantalla |
|---|---|---|---|
| 0 | **Portafolio** | "Cuatro clientes sintéticos; dos casos prioritarios porque ya vencieron. Las cifras salen de la base." | KPIs reales de SQLite y la regla de "prioritario" visible |
| 1 | **Demo en 2 minutos** → *Crear caso de María* → *Abrir expediente* | "Este es el expediente de María: cuota, saldo, pagos, próxima acción." | Tarjeta de cliente sin IDs técnicos |
| 2 | *Ejecutar análisis* | "Un orquestador coordina un ANALISTA, un GESTOR IA y un SUPERVISOR." | Cada componente con su motor (REGLAS / IA REAL) |
| 3 | *Mostrar control* | "El supervisor valida 11 controles: horario, consentimiento, sin presión, ofertas condicionadas, opción de baja." | 11 de 11 controles superados |
| 4 | *Aprobar como revisor humano* | "Nada sale sin aprobación humana. Y no se envía nada real." | Gestión programada vinculada a la decisión |
| 5 | *Simular respuesta y reanalizar* | "María responde que no le alcanza. El Gestor IA la interpreta." | **Panel de evidencia**: ver sección siguiente |
| 6 | *Confirmar pago completo* | "El banco confirma el pago: solo el simulador bancario puede hacerlo." | Lista de cambios de la traza real del evento |
| 7 | (automático) | "Saldo nuevo, cuota regularizada, gestión cancelada, la segunda recomendación quedó obsoleta y no se puede aprobar." | Saldo antes/ahora, "Cuota pagada: Regularizada", línea de tiempo |

## Qué decir sobre la IA (importante)
- **Sin clave de OpenAI**: el panel dice *"REGLAS · Esta ejecución NO usó IA generativa"*. Es la verdad: los 7 componentes son reglas deterministas.
- **Con clave y modelo configurados** (`LLM_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL` en `.env`): el panel dice *"IA REAL · OpenAI"* y muestra
  modelo, herramientas de solo lectura efectivamente llamadas, tiempo, tokens y el id de la traza en `agent_runs`.
- **Si OpenAI falla**: *"FALLBACK A REGLAS"* con el motivo; el flujo sigue con plantillas.
- El LLM **solo propone**: no registra pagos, no aprueba, no elige canal ni horario, no modifica contratos.

## Si algo sale mal
- "Este caso de María ya se usó" → confirma y crea un caso nuevo (los datos anteriores se conservan).
- Botón gris = el paso anterior aún no se hizo (los pasos no se pueden saltar).
- Para repetir con otros clientes: **Expediente del cliente** → pestañas *Siguiente mejor acción* y *Simular eventos*.
