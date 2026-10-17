import { z } from "zod";

/** Fila de la tabla `cartera`. Los campos sim_* son solo del simulador: ningún agente los ve. */
export type Cliente = {
  cliente_id: string;
  nombre: string;
  celular: string;
  canal_preferido: "whatsapp" | "sms" | "llamada";
  hora_respuesta: string;
  producto: string;
  saldo_deuda: number;
  monto_cuota: number;
  fecha_vencimiento: string; // YYYY-MM-DD
  dias_atraso: number;
  dia_abono_sueldo: number;
  sueldo_llego_mes: boolean;
  saldo_cuenta: number;
  uso_linea_tc_pct: number;
  atrasos_ult_6m: number;
  prob_no_pago: number | null;
  causa_probable: string | null;
  prioridad: "alta" | "media" | "baja" | null;
  grupo: "tratamiento" | "control";
  pago_a_tiempo: boolean | null;
  sim_escenario: string;
  sim_pago_base: boolean;
};

/** Lo que ven los agentes: sin campos del simulador. */
export type ClientePublico = Omit<Cliente, "sim_escenario" | "sim_pago_base" | "pago_a_tiempo">;

export type Regla = { regla_id: number; tipo: string; condicion: string; valor: string; descripcion: string };

export type ActorId = "analista" | "supervisor" | "gestor" | "cliente" | "humano" | "bd";

export type Gestion = {
  gestion_id: number;
  cliente_id: string;
  fecha: string;
  agente: ActorId;
  accion: string;
  canal: string | null;
  mensaje: string | null;
  resultado: string | null;
  motivo_no_pago: string | null;
  monto_promesa: number | null;
  fecha_promesa: string | null;
  /** pendiente → (fecha alcanzada) → cumplida (pago CONFIRMADO) | cumplida_simulada (pago del SIMULADOR) | rota | cancelada (obsoleta). */
  estado_promesa: EstadoPromesa | null;
  derivado_humano: boolean;
  justificacion: string | null;
  /** Fecha/hora (hora local YYYY-MM-DDTHH:MM) en que quedó programado un contacto. */
  programado_para: string | null;
  /** Quién originó la decisión: gestor_llm | gestor_reglas | gestor_fallback | asesor_humano | supervisor | analista | cliente_simulado. */
  origen: string | null;
  /** Estado de aprobación: validada_supervisor | rechazada_supervisor | pendiente_humano | no_aplica. */
  aprobacion: string | null;
  /** Motor que ejecutó el paso: llm | reglas | fallback | simulacion | humano. */
  motor: string | null;
};
export type EstadoPromesa = "pendiente" | "cumplida" | "cumplida_simulada" | "rota" | "cancelada";
export type NuevaGestion = Omit<Gestion, "gestion_id" | "fecha" | "programado_para" | "origen" | "aprobacion" | "motor"> &
  Partial<Pick<Gestion, "programado_para" | "origen" | "aprobacion" | "motor">> & { fecha?: string };

/** Pago registrado. 'simulado' lo genera el simulador de la demo (NO mueve saldo); 'confirmado' viene de un evento autorizado de conciliación. */
export type Pago = {
  pago_id: number; cliente_id: string; referencia: string; monto: number; fecha: string;
  origen: "simulador" | "conciliacion_banco"; estado: "simulado" | "confirmado"; promesa_id: number | null;
};
export type NuevoPago = { cliente_id: string; referencia: string; monto: number; origen: Pago["origen"]; promesa_id?: number | null };
export type ResultadoPago =
  | { estado: "aplicado"; pago: Pago; saldo_restante: number }
  | { estado: "simulado"; pago: Pago }
  | { estado: "duplicado"; pago: Pago }
  | { estado: "rechazado"; motivo: string };

export type MotorEjecucion = "llm" | "reglas" | "fallback";
/** Qué motor produjo realmente un turno del Gestor (nunca se etiqueta "llm" si corrieron reglas). */
export type TurnoMeta = {
  motor: MotorEjecucion; modelo?: string; latencia_ms?: number; tokens_in?: number | null; tokens_out?: number | null;
  error?: string; guardrail?: string;
};

export const MOTIVOS = [
  "retraso_ingresos", "iliquidez", "olvido", "desempleo", "reclamo", "desconoce_deuda", "otro", "desconocido",
  // Solicitudes que el sistema no puede resolver solo (ver reglas 9-10): se derivan a una persona.
  "pago_declarado", "solicitud_fuera_de_politica", "no_contactar",
] as const;
export type Motivo = (typeof MOTIVOS)[number];

/** Salida estructurada del Gestor en cada turno de la conversación. */
export const GestorTurnSchema = z.object({
  mensaje: z.string().describe("Mensaje para el cliente, listo para enviar, en español, breve y respetuoso"),
  motivo_no_pago: z.enum(MOTIVOS).describe("Motivo de no pago identificado hasta ahora; 'desconocido' si aún no se sabe"),
  accion: z.enum(["preguntar", "ofrecer", "registrar_promesa", "escalar_humano", "cerrar"]),
  regla_id: z.number().int().nullable().describe("regla_id de la opción de pago ofrecida (solo reglas opcion_pago); null si no ofrece"),
  monto_promesa: z.number().nullable().describe("Monto prometido por el cliente (solo con registrar_promesa)"),
  fecha_promesa: z.string().nullable().describe("Fecha prometida YYYY-MM-DD (solo con registrar_promesa)"),
  justificacion: z.string().describe("Por qué decidiste esto, citando lo que dijo el cliente y la regla aplicada (1-2 frases)"),
  resumen_humano: z.string().nullable().describe("Solo con escalar_humano: resumen del caso para la persona que lo tomará"),
  borrador_humano: z.string().nullable().describe("Solo con escalar_humano: borrador de mensaje sugerido para que el humano lo edite"),
});
export type GestorTurn = z.infer<typeof GestorTurnSchema>;
export type GestorResultado = GestorTurn & { meta?: TurnoMeta };

export type Turno = { rol: "gestor" | "cliente" | "humano"; texto: string };

export type Propuesta = { canal: string; fecha: string; hora: string; justificacion: string };

export type EventoAgente = {
  id: number;
  de: ActorId;
  a: ActorId;
  tipo: "consulta" | "propuesta" | "validacion" | "mensaje" | "respuesta" | "registro" | "escalamiento" | "seguimiento";
  titulo: string;
  texto?: string;
  estado: "ok" | "rechazado" | "info";
  datos?: unknown;
};

export type EventoStream =
  | { tipo: "evento"; evento: EventoAgente }
  | { tipo: "fin"; estado: "esperando_humano" | "promesa_registrada" | "cerrado" | "control" | "sin_respuesta" | "contacto_programado" | "reintento_programado" | "bloqueado" | "error"; detalle?: string };

/** Estados reales del contacto (se derivan de `gestiones`, ver core/estado.ts). */
export const ESTADOS_CONTACTO = ["ninguno", "validado", "programado", "enviado_simulado", "respuesta_recibida", "sin_respuesta", "escalado", "cerrado"] as const;
export type EstadoContacto = (typeof ESTADOS_CONTACTO)[number];

export type Kpis = {
  totalClientes: number;
  conversaciones: number;
  prioridad: { alta: number; media: number; baja: number };
  pagoAltoRiesgo: { grupo: "tratamiento" | "control"; n: number; pagan: number }[];
  liftPp: number | null;
  /** cumplidas = con pago CONFIRMADO; cumplidasSimuladas = el simulador generó un pago simulado (no es recuperación observada). */
  promesas: { total: number; cumplidas: number; cumplidasSimuladas: number; rotas: number; pendientes: number; canceladas: number };
  gestion: { contactosProgramados: number; sinRespuesta: number; escalados: number; reintentos: number };
  pagos: { simulados: { n: number; monto: number }; confirmados: { n: number; monto: number } };
  llm: {
    llamadas: number; fallidas: number; tokensIn: number | null; tokensOut: number | null; latenciaMediaMs: number | null;
    porRol: { rol: string; modelo: string; llamadas: number; tokensIn: number | null; tokensOut: number | null }[];
    casosConLlm: number; casosSinLlm: number;
  };
  canales: { canal: string; contactos: number }[];
  motivos: { motivo: string; n: number }[];
  derivados: { derivados: number; conversaciones: number };
};
