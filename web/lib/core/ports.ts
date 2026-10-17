/**
 * Puertos del dominio. La lógica (Analista, Supervisor, orquestador) solo depende de esto;
 * las implementaciones viven en lib/adapters y se eligen en lib/container.ts
 * (SQLite hoy; Supabase/Postgres en la fase 3 sin tocar el dominio).
 */
import type { Cliente, ClientePublico, EstadoPromesa, Gestion, GestorResultado, Kpis, NuevaGestion, NuevoPago, Pago, Regla, ResultadoPago, Turno } from "./types";

export interface CarteraRepository {
  list(): Promise<Cliente[]>;
  get(id: string): Promise<Cliente | undefined>;
  actualizarAnalisis(id: string, a: { prob_no_pago: number; causa_probable: string; prioridad: string }): Promise<void>;
  setPagoATiempo(id: string, pago: boolean): Promise<void>;
}

export interface GestionRepository {
  insertar(g: NuevaGestion): Promise<Gestion>;
  porCliente(id: string): Promise<Gestion[]>;
  actualizarPromesa(gestionId: number, estado: Exclude<EstadoPromesa, "pendiente">): Promise<void>;
  promesasPendientes(clienteId?: string): Promise<Gestion[]>;
  contactosIniciales(clienteId: string, desdeIso: string): Promise<number>;
}

export interface ReglaRepository {
  todas(): Promise<Regla[]>;
}

/** Calcula la probabilidad de no pago (modelo logístico entrenado sobre la cartera sintética). */
export interface RiskModel {
  readonly name: string;
  probabilidad(c: ClientePublico): number;
  /** Aporte de cada variable al puntaje (mayor = empuja hacia no pago). */
  explicar(c: ClientePublico): { variable: string; aporte: number }[];
}

/** El Gestor: conversa, identifica el motivo y ofrece solo opciones de la tabla `reglas`. */
export interface GestorAgent {
  readonly name: string;
  turno(input: {
    cliente: ClientePublico;
    reglas: Regla[];
    historial: Turno[];
    hoy: string;
    numeroTurno: number;
    retroalimentacion?: string;
    humanoActivo?: boolean;
  }): Promise<GestorResultado>;
}

/** Simula al cliente para poder cerrar el ciclo en la demo. Conoce un escenario oculto. */
export interface ClienteSimulator {
  readonly name: string;
  /** Devuelve el texto del cliente, o null si el cliente NO responde (silencio). */
  responder(input: { cliente: Cliente; historial: Turno[]; ultimoMensaje: string; deHumano: boolean; hoy: string }): Promise<string | null>;
}

/** Revisión de tono (apoya al Supervisor). Devuelve probabilidad de que el mensaje sea respetuoso. */
export interface ToneChecker {
  readonly name: string;
  respetuoso(mensaje: string): Promise<number>;
}

/**
 * Pagos. `simulador` queda registrado pero NO mueve saldo; `conciliacion_banco` (evento autorizado) sí lo descuenta,
 * de forma atómica, idempotente por `referencia` y sin permitir saldos negativos.
 */
export interface PagoRepository {
  registrar(p: NuevoPago): Promise<ResultadoPago>;
  porCliente(id: string): Promise<Pago[]>;
}

/** Indicadores calculados con consultas SQL sobre `cartera` y `gestiones`. */
export interface KpiRepository {
  kpis(): Promise<Kpis>;
}
