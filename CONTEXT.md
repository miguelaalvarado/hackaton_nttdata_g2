# Contexto del proyecto — Hack AI Agents (Perú Tech Week, 17-oct-2026)

NTT DATA + Sundai LATAM + NANDA Project (MIT Media Lab). Fuente: `Hack AI Agents (1).docx` (en la raíz del repo).

## 1. Caso elegido: B3 — Cobranza temprana (Banca)

**Problema.** Las campañas de cobranza son genéricas por segmento, no por comportamiento individual, y reaccionan tarde a las señales de deterioro.
**Por qué importa.** Una llamada preventiva cuesta mucho menos que una gestión judicial. Actuar tarde o por el canal equivocado se traduce en pérdida esperada.
**Enfoque pedido.** Un agente que monitoree señales (uso de línea, pagos mínimos sostenidos, cambios de frecuencia), calcule la probabilidad de mora temprana y recomiende canal y mensaje por cliente, ajustando según la respuesta observada.

> Nota: los dos links de Kaggle que se compartieron (IBM AML y SAML-D) son del caso **B1 (alertas AML)**, no de B3. Se revisaron igual (sección 3.3). Si el equipo prefiere B1, ver sección 8.

### Criterios de evaluación (20 % cada uno)
1. **Ejecución:** el prototipo corre en vivo. Mejor un flujo corto que funcione de punta a punta que una demo ambiciosa que se cae.
2. **Aplicación práctica:** un experto de banca debe pensar "esto me ayuda en mi día a día".
3. **Experiencia de usuario:** clara, no pulida. Qué hace, cómo se usa y qué responde en cada paso.
4. **Innovación:** ángulo distinto al obvio (varios equipos harán "modelo de PD + chatbot").
5. **Uso de IA inmerso:** el agente es el motor que resuelve la parte difícil, no un chatbot pegado encima. Hay que explicar qué decide el agente y qué tan autónomo es.

## 2. Entorno (ya montado)

- Gestor: `uv` 0.13.1. Proyecto con `pyproject.toml` y `.venv` (kaggle 2.2.4, pandas 3.0.6, scikit-learn).
- Kaggle autenticado con `uv run kaggle auth login` (cuenta `miguelaalvaradoramos`).
- `data/` y `.venv/` están en `.gitignore`.
- Comandos útiles:
  - `uv run kaggle datasets list -s <tema>`
  - `uv run kaggle datasets files <owner>/<slug>`
  - `uv run kaggle datasets download -d <owner>/<slug> -p data/<dir> --unzip`

## 3. Datasets revisados (todo verificado localmente)

### 3.1 Give Me Some Credit — `brycecf/give-me-some-credit-dataset` → `data/gmsc/`
- `cs-training.csv`: 150 000 filas × 11 columnas. `cs-test.csv` sin etiqueta. Hay `Data Dictionary.xls`.
- Target: `SeriousDlqin2yrs` (mora ≥90 días en 2 años). **Tasa de mora 6.68 %** (desbalanceado).
- Features de comportamiento: `RevolvingUtilizationOfUnsecuredLines` (uso de línea), `NumberOfTime30-59DaysPastDueNotWorse`, `NumberOfTime60-89DaysPastDueNotWorse`, `NumberOfTimes90DaysLate`, `DebtRatio`, `MonthlyIncome`, `age`, `NumberOfOpenCreditLinesAndLoans`, `NumberRealEstateLoansOrLines`, `NumberOfDependents`.
- Calidad: nulos en `MonthlyIncome` (19.8 %) y `NumberOfDependents` (2.6 %). Outliers fuertes: utilización máx. 50 708, `DebtRatio` máx. 329 664, valores centinela 96/98 en los conteos de atrasos, edad mínima 0. Hay que limpiar y cortar (clip).
- Señal muy clara: tasa de mora por número de atrasos ≥90 días: 0 atrasos → 4.6 %; 1 → 33.7 %; 2-3 → 52.3 %; 4+ → 62.5 %.
- **Baseline: HistGradientBoosting sin ajustar, AUC = 0.866** (split 75/25 estratificado).

### 3.2 Loan Default Prediction — `nikhil1e9/loan-default` → `data/loan/Loan_default.csv`
- 255 347 filas × 18 columnas, sin nulos. Es el "255K registros" del enunciado.
- Target: `Default`. **Tasa de mora 11.61 %.**
- Columnas: `Age, Income, LoanAmount, CreditScore, MonthsEmployed, NumCreditLines, InterestRate, LoanTerm, DTIRatio, Education, EmploymentType, MaritalStatus, HasMortgage, HasDependents, LoanPurpose, HasCoSigner`, más `LoanID`.
- Es de originación (demográfico y del préstamo), **no tiene comportamiento de pago ni series temporales**. Casi sin señal en `CreditScore` (13.1 % de mora en el cuartil bajo vs 10.2 % en el alto). Desempleados 13.6 % vs tiempo completo 9.5 %.
- **Baseline: AUC = 0.757.**

### 3.3 Datasets AML (caso B1, solo para referencia)
- `berkanoztas/synthetic-transaction-monitoring-dataset-aml` (SAML-D) → `data/saml/SAML-D.csv`, ~1 GB. En una muestra de 500 000 filas: 12 columnas (`Time, Date, Sender_account, Receiver_account, Amount, Payment_currency, Received_currency, Sender_bank_location, Receiver_bank_location, Payment_type, Is_laundering, Laundering_type`). Lavado ≈ 0.11 % en la muestra. Tipologías sospechosas visibles: Structuring, Cash_Withdrawal, Smurfing, Stacked Bipartite, Layered_Fan_Out, Behavioural_Change, Deposit-Send, Fan_In.
- `ealtman2019/ibm-transactions-for-anti-money-laundering-aml` → solo se pidió `HI-Small_Trans.csv` (~475 MB) en `data/ibm/`. El dataset completo pesa decenas de GB (los Large rondan 17 GB cada uno). Columnas: `Timestamp, From Bank, Account, To Bank, Account, Amount Received, Receiving Currency, Amount Paid, Payment Currency, Payment Format, Is Laundering`. Incluye archivos `*_Patterns.txt` con los esquemas de lavado.
- Estos datasets **no tienen cuentas de crédito, atrasos ni mora**. No sirven para entrenar el modelo de B3.

## 4. Brecha clave de los datos (decisión de diseño)

Ningún dataset de B3 trae: serie temporal por cliente, canal de contacto, respuesta a contactos ni costos. GMSC es una foto estática; Loan Default es de originación. Por eso la parte "adaptar la estrategia según la respuesta observada" **hay que simularla**, y el equipo debe decirlo abiertamente al jurado.

Plan de datos:
1. **Modelo de PD real** entrenado en GMSC (señales de comportamiento), con Loan Default como segundo segmento o benchmark (ejemplo: cartera de préstamos a plazo vs. tarjeta revolvente).
2. **Línea de tiempo sintética** por cliente (12 meses de uso de línea, pagos mínimos, frecuencia de transacciones), generada a partir de sus features reales de GMSC. Los clientes con perfil de riesgo reciben trayectorias de deterioro.
3. **Simulador de respuesta a contactos** (probabilidad de contacto efectivo / promesa de pago / pago, por canal y perfil) y **tabla de costos por canal** como supuestos explícitos y parametrizables. Los números de costo son supuestos, no datos.

## 5. Propuesta de solución: «Cobrador» — agente de cobranza temprana adaptativa

**Idea central (ángulo de innovación):** no es "modelo de PD + chatbot". Es un bucle agéntico que **decide el siguiente mejor contacto por cliente, mide la respuesta y reajusta**, con un análisis explícito de costo-beneficio y reglas de conducta que el agente debe respetar.

### Arquitectura
```
Señales mensuales ──► [Agente Monitor] ──► cola de clientes en riesgo
                         │ tools: get_signals, score_pd, explain_pd
                         ▼
                 [Agente Estratega] (LLM con tool-use)
                   tools: get_client_profile, contact_history,
                          channel_costs, expected_loss(PD, EAD),
                          policy_check, bandit_recommend
                   → decide: cuándo, canal, tono, oferta (recordatorio,
                     reprogramación, plan de pago), con justificación
                         ▼
                 [Agente Redactor] → mensaje personalizado por canal
                         ▼
                 [Guardrail / Cumplimiento] → horarios, máx. contactos
                   por semana, tono, no amenazas; rechaza o corrige
                         ▼
          Analista humano aprueba / edita (human-in-the-loop)
                         ▼
        [Simulador de respuesta] ──► feedback ──► bandit contextual
                                             └──► Estratega (memoria del caso)
```

### Qué hace el LLM y qué no
- **Modelo tabular (GBM)**: calcula la probabilidad de mora. No se delega al LLM.
- **Contextual bandit** (por ejemplo Thompson sampling por segmento × canal): aprende de la respuesta simulada qué canal funciona mejor. Es lo que hace real el "ajustar según la respuesta".
- **Agente LLM**: razona sobre el caso con las tools, equilibra costo del canal contra pérdida esperada, explica el porqué en lenguaje natural, redacta el mensaje y escala los casos ambiguos. Este es el valor visible para el criterio 5.
- **Guardrail**: reglas determinísticas más una verificación del LLM; todo queda registrado para trazabilidad.

### Decisión económica (visible en la demo)
Para cada cliente: `pérdida_esperada = PD × EAD × LGD`. El agente elige la acción que maximiza `reducción_esperada_de_pérdida − costo_del_canal`. Canales a comparar: push/SMS/WhatsApp (muy bajo costo), correo, llamada preventiva, llamada de asesor, gestión de cobranza avanzada. Los costos son parámetros editables en pantalla.

## 6. UX / demo (3-4 minutos, flujo único que no se cae)

1. **Cartera**: tabla de clientes ordenada por PD con la tendencia de las últimas semanas; el usuario es un gestor de cobranza.
2. **Selecciona un cliente** → el agente muestra su razonamiento paso a paso (señales que subieron, PD actual y por qué, historial de contactos).
3. **Recomendación**: canal, hora, tono, oferta y mensaje redactado, con el costo vs. la pérdida evitada. Botones: aprobar / editar / rechazar.
4. **Bucle de feedback**: al aprobar, el simulador responde (ej. no contesta la llamada); el agente **cambia de estrategia** (pasa a WhatsApp con otra oferta) y lo explica.
5. **Vista de cartera**: comparación "campaña genérica por segmento vs. agente adaptativo" (mora evitada y costo total sobre la cartera simulada). Es el gráfico que cierra la historia.

## 7. Cómo cubre los criterios

| Criterio | Cómo se cumple |
|---|---|
| Ejecución | Un solo flujo end-to-end con datos reales de GMSC y simulador; sin dependencias externas frágiles (modelo pre-entrenado y guardado) |
| Aplicación práctica | Gestor de cobranza como usuario; métricas de costo y pérdida evitada; reglas de conducta de cobranza |
| UX | Cartera → caso → recomendación explicada → aprobar; razonamiento visible |
| Innovación | Decisión por cliente con costo-beneficio explícito, bandit que aprende de la respuesta, y agente que cambia de táctica en vivo |
| IA inmersa | El agente decide con tools, razona, redacta y se autocorrige con guardrails; el GBM es una herramienta suya |

## 8. Alternativa: pivotar a B1 (AML) si el equipo lo prefiere

Con SAML-D o IBM: agente que, dada una alerta, arme el perfil transaccional de la cuenta, detecte patrones (estructuración, fan-in/fan-out, ciclos), consulte una lista de riesgo, cite normativa (RAG, ver B2) y recomiende descartar o escalar con justificación trazable. Ventaja: los datos ya traen etiqueta de tipología. Costo: los volúmenes son grandes (SAML-D ≈ 1 GB; hay que muestrear) y hace falta construir las vistas de grafo y perfil. Es una decisión del equipo; el resto de este documento asume B3.

## 9. Plan para un día de hack

| Bloque | Entregable |
|---|---|
| 1 | Limpieza de GMSC, modelo de PD guardado (`joblib`), explicaciones por cliente |
| 2 | Generador de series sintéticas y simulador de respuesta + tabla de costos |
| 3 | Agente (tools + LLM) y guardrails; bandit |
| 4 | Interfaz (Streamlit o similar) con el flujo de la sección 6 |
| 5 | Gráfico comparativo, guion de la demo, ensayo; congelar features |

Regla: si el flujo base no es estable, no se agregan funciones nuevas.

## 10. Riesgos

- **Honestidad con los datos:** la línea de tiempo, las respuestas a contactos y los costos son sintéticos. Declararlo y mostrar que el modelo de PD sí es real.
- **Desbalance (6.7 %):** reportar AUC y recall en el top-k, no accuracy.
- **Fuga de información / outliers de GMSC:** limpiar centinelas 96/98 antes de entrenar.
- **Latencia del LLM en vivo:** precomputar los casos de la demo y dejar uno en vivo.
- **Cumplimiento:** el agente nunca amenaza ni contacta fuera de horario; la aprobación humana es parte del diseño.

## 11. Pendientes / decisiones abiertas

- Confirmar con el equipo B3 vs. B1.
- Elegir LLM y framework de agentes (el tool-use directo con la API basta para un día).
- Definir los valores de EAD, LGD y costos por canal (supuestos).
- `HI-Small_Trans.csv` ya terminó de descargarse en `data/ibm/`; no se perfiló a fondo (solo cabecera).
