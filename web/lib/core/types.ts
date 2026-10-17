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
  estado_promesa: "pendiente" | "cumplida" | "rota" | null;
  derivado_humano: boolean;
  justificacion: string | null;
};
export type NuevaGestion = Omit<Gestion, "gestion_id" | "fecha"> & { fecha?: string };

export const MOTIVOS = ["retraso_ingresos", "iliquidez", "olvido", "desempleo", "reclamo", "desconoce_deuda", "otro", "desconocido"] as const;
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
  | { tipo: "fin"; estado: "esperando_humano" | "promesa_registrada" | "cerrado" | "control" | "sin_respuesta" | "error"; detalle?: string };

export type Kpis = {
  totalClientes: number;
  conversaciones: number;
  prioridad: { alta: number; media: number; baja: number };
  pagoAltoRiesgo: { grupo: "tratamiento" | "control"; n: number; pagan: number }[];
  liftPp: number | null;
  promesas: { total: number; cumplidas: number; rotas: number; pendientes: number };
  motivos: { motivo: string; n: number }[];
  derivados: { derivados: number; conversaciones: number };
};
