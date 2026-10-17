import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client as Libsql, type Row } from "@libsql/client";
import carteraSeed from "../../seed/cartera.json";
import reglasSeed from "../../seed/reglas.json";
import { estadoCaso } from "../core/estado";
import type { CarteraRepository, GestionRepository, KpiRepository, PagoRepository, ReglaRepository } from "../core/ports";
import { isoDate, sumarDias } from "../core/reglas";
import type { Cliente, Gestion, NuevaGestion, NuevoPago, Pago, Regla, ResultadoPago } from "../core/types";

const DDL = [
  `CREATE TABLE IF NOT EXISTS cartera (
    cliente_id TEXT PRIMARY KEY, nombre TEXT, celular TEXT, canal_preferido TEXT, hora_respuesta TEXT,
    producto TEXT, saldo_deuda REAL, monto_cuota REAL, fecha_vencimiento TEXT, dias_atraso INTEGER,
    dia_abono_sueldo INTEGER, sueldo_llego_mes INTEGER, saldo_cuenta REAL, uso_linea_tc_pct REAL, atrasos_ult_6m INTEGER,
    prob_no_pago REAL, causa_probable TEXT, prioridad TEXT, grupo TEXT,
    pago_a_tiempo INTEGER, sim_escenario TEXT, sim_pago_base INTEGER)`,
  `CREATE TABLE IF NOT EXISTS gestiones (
    gestion_id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id TEXT REFERENCES cartera(cliente_id), fecha TEXT,
    agente TEXT, accion TEXT, canal TEXT, mensaje TEXT, resultado TEXT, motivo_no_pago TEXT,
    monto_promesa REAL, fecha_promesa TEXT, estado_promesa TEXT, derivado_humano INTEGER DEFAULT 0, justificacion TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_gestiones_cliente ON gestiones(cliente_id)`,
  `CREATE TABLE IF NOT EXISTS reglas (
    regla_id INTEGER PRIMARY KEY, tipo TEXT, condicion TEXT, valor TEXT, descripcion TEXT)`,
  // Pagos: 'simulado' (simulador de la demo, no mueve saldo) o 'confirmado' (conciliación autorizada). `referencia` única = idempotencia.
  `CREATE TABLE IF NOT EXISTS pagos (
    pago_id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id TEXT NOT NULL REFERENCES cartera(cliente_id), referencia TEXT NOT NULL UNIQUE,
    monto REAL NOT NULL CHECK(monto > 0), fecha TEXT NOT NULL, origen TEXT NOT NULL CHECK(origen IN ('simulador','conciliacion_banco')),
    estado TEXT NOT NULL CHECK(estado IN ('simulado','confirmado')), promesa_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_pagos_cliente ON pagos(cliente_id)`,
  // Telemetría REAL de llamadas al LLM (una fila por invocación). tokens NULL = el proveedor no devolvió `usage`.
  `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, cliente_id TEXT, rol TEXT NOT NULL, modelo TEXT NOT NULL,
    latencia_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, ok INTEGER NOT NULL, error TEXT)`,
];
/** Columnas añadidas a `gestiones` en esta versión (migración aditiva: no toca datos existentes). */
const COLUMNAS_NUEVAS = ["programado_para TEXT", "origen TEXT", "aprobacion TEXT", "motor TEXT"];

type G = { __db?: Libsql; __dbReady?: Promise<Libsql> };
const g = globalThis as unknown as G;

export function dbUrl() {
  return process.env.DB_URL ?? "file:./data/cobranza.db";
}

async function seed(db: Libsql) {
  const n = Number((await db.execute("SELECT COUNT(*) n FROM cartera")).rows[0].n);
  if (n > 0) {
    // Base existente: solo se añaden las reglas nuevas (no se pisan las que alguien editó).
    await db.batch((reglasSeed as Regla[]).map((r) => ({
      sql: "INSERT OR IGNORE INTO reglas (regla_id,tipo,condicion,valor,descripcion) VALUES (?,?,?,?,?)",
      args: [r.regla_id, r.tipo, r.condicion, r.valor, r.descripcion],
    })), "write");
    return;
  }
  const hoy = isoDate(new Date());
  const stmts = (carteraSeed as Record<string, unknown>[]).map((c) => ({
    sql: `INSERT INTO cartera (cliente_id,nombre,celular,canal_preferido,hora_respuesta,producto,saldo_deuda,monto_cuota,fecha_vencimiento,
          dias_atraso,dia_abono_sueldo,sueldo_llego_mes,saldo_cuenta,uso_linea_tc_pct,atrasos_ult_6m,grupo,sim_escenario,sim_pago_base)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      c.cliente_id, c.nombre, c.celular, c.canal_preferido, c.hora_respuesta, c.producto, c.saldo_deuda, c.monto_cuota,
      Number(c.dias_atraso) > 0 ? sumarDias(hoy, -Number(c.dias_atraso)) : sumarDias(hoy, Number(c.venc_en_dias)),
      c.dias_atraso, c.dia_abono_sueldo, c.sueldo_llego_mes ? 1 : 0, c.saldo_cuenta, c.uso_linea_tc_pct, c.atrasos_ult_6m,
      c.grupo, c.sim_escenario, c.sim_pago_base ? 1 : 0,
    ] as (string | number | null)[],
  }));
  for (const r of reglasSeed as Regla[]) {
    stmts.push({
      sql: "INSERT OR REPLACE INTO reglas (regla_id,tipo,condicion,valor,descripcion) VALUES (?,?,?,?,?)",
      args: [r.regla_id, r.tipo, r.condicion, r.valor, r.descripcion],
    });
  }
  await db.batch(stmts, "write");
}

/** Abre la base, crea las 3 tablas y carga la semilla si está vacía. */
export function getDb(): Promise<Libsql> {
  return (g.__dbReady ??= (async () => {
    const url = dbUrl();
    if (url.startsWith("file:")) mkdirSync(dirname(url.slice(5)), { recursive: true });
    const db = createClient({ url, authToken: process.env.DB_AUTH_TOKEN });
    g.__db = db;
    for (const ddl of DDL) await db.execute(ddl);
    const cols = new Set((await db.execute("PRAGMA table_info(gestiones)")).rows.map((r) => String(r.name)));
    for (const c of COLUMNAS_NUEVAS) if (!cols.has(c.split(" ")[0])) await db.execute(`ALTER TABLE gestiones ADD COLUMN ${c}`);
    await seed(db);
    return db;
  })());
}

/** Borra todo y vuelve a cargar la semilla (botón "reiniciar demo"). */
export async function resetDb() {
  const db = await getDb();
  await db.batch([
    "DELETE FROM gestiones", "DELETE FROM pagos", "DELETE FROM llm_calls",
    "DELETE FROM sqlite_sequence WHERE name IN ('gestiones','pagos','llm_calls')", "DELETE FROM cartera", "DELETE FROM reglas",
  ], "write");
  await seed(db);
}

const toBool = (v: unknown) => (v === null || v === undefined ? null : Number(v) === 1);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const rowToCliente = (r: Row): Cliente => ({
  cliente_id: String(r.cliente_id), nombre: String(r.nombre), celular: String(r.celular),
  canal_preferido: String(r.canal_preferido) as Cliente["canal_preferido"], hora_respuesta: String(r.hora_respuesta),
  producto: String(r.producto), saldo_deuda: Number(r.saldo_deuda), monto_cuota: Number(r.monto_cuota),
  fecha_vencimiento: String(r.fecha_vencimiento), dias_atraso: Number(r.dias_atraso), dia_abono_sueldo: Number(r.dia_abono_sueldo),
  sueldo_llego_mes: Number(r.sueldo_llego_mes) === 1, saldo_cuenta: Number(r.saldo_cuenta), uso_linea_tc_pct: Number(r.uso_linea_tc_pct),
  atrasos_ult_6m: Number(r.atrasos_ult_6m), prob_no_pago: num(r.prob_no_pago),
  causa_probable: r.causa_probable === null ? null : String(r.causa_probable),
  prioridad: r.prioridad === null ? null : (String(r.prioridad) as Cliente["prioridad"]),
  grupo: String(r.grupo) as Cliente["grupo"], pago_a_tiempo: toBool(r.pago_a_tiempo),
  sim_escenario: String(r.sim_escenario), sim_pago_base: Number(r.sim_pago_base) === 1,
});

const rowToGestion = (r: Row): Gestion => ({
  gestion_id: Number(r.gestion_id), cliente_id: String(r.cliente_id), fecha: String(r.fecha),
  agente: String(r.agente) as Gestion["agente"], accion: String(r.accion),
  canal: r.canal === null ? null : String(r.canal), mensaje: r.mensaje === null ? null : String(r.mensaje),
  resultado: r.resultado === null ? null : String(r.resultado),
  motivo_no_pago: r.motivo_no_pago === null ? null : String(r.motivo_no_pago),
  monto_promesa: num(r.monto_promesa), fecha_promesa: r.fecha_promesa === null ? null : String(r.fecha_promesa),
  estado_promesa: r.estado_promesa === null ? null : (String(r.estado_promesa) as Gestion["estado_promesa"]),
  derivado_humano: Number(r.derivado_humano) === 1,
  justificacion: r.justificacion === null ? null : String(r.justificacion),
  programado_para: r.programado_para == null ? null : String(r.programado_para),
  origen: r.origen == null ? null : String(r.origen), aprobacion: r.aprobacion == null ? null : String(r.aprobacion),
  motor: r.motor == null ? null : String(r.motor),
});

export const sqliteCartera: CarteraRepository = {
  async list() {
    const db = await getDb();
    return (await db.execute("SELECT * FROM cartera ORDER BY COALESCE(prob_no_pago,0) DESC, cliente_id")).rows.map(rowToCliente);
  },
  async get(id) {
    const db = await getDb();
    const r = (await db.execute({ sql: "SELECT * FROM cartera WHERE cliente_id = ?", args: [id] })).rows[0];
    return r ? rowToCliente(r) : undefined;
  },
  async actualizarAnalisis(id, a) {
    const db = await getDb();
    await db.execute({
      sql: "UPDATE cartera SET prob_no_pago=?, causa_probable=?, prioridad=? WHERE cliente_id=?",
      args: [a.prob_no_pago, a.causa_probable, a.prioridad, id],
    });
  },
  async setPagoATiempo(id, pago) {
    const db = await getDb();
    await db.execute({ sql: "UPDATE cartera SET pago_a_tiempo=? WHERE cliente_id=?", args: [pago ? 1 : 0, id] });
  },
};

export const sqliteGestiones: GestionRepository = {
  async insertar(gs: NuevaGestion) {
    const db = await getDb();
    const fecha = gs.fecha ?? new Date().toISOString();
    const r = await db.execute({
      sql: `INSERT INTO gestiones (cliente_id,fecha,agente,accion,canal,mensaje,resultado,motivo_no_pago,monto_promesa,fecha_promesa,estado_promesa,derivado_humano,justificacion,
              programado_para,origen,aprobacion,motor)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [gs.cliente_id, fecha, gs.agente, gs.accion, gs.canal, gs.mensaje, gs.resultado, gs.motivo_no_pago, gs.monto_promesa,
        gs.fecha_promesa, gs.estado_promesa, gs.derivado_humano ? 1 : 0, gs.justificacion,
        gs.programado_para ?? null, gs.origen ?? null, gs.aprobacion ?? null, gs.motor ?? null],
    });
    return { ...gs, fecha, gestion_id: Number(r.lastInsertRowid), programado_para: gs.programado_para ?? null, origen: gs.origen ?? null,
      aprobacion: gs.aprobacion ?? null, motor: gs.motor ?? null };
  },
  async porCliente(id) {
    const db = await getDb();
    return (await db.execute({ sql: "SELECT * FROM gestiones WHERE cliente_id = ? ORDER BY gestion_id", args: [id] })).rows.map(rowToGestion);
  },
  async actualizarPromesa(gestionId, estado) {
    const db = await getDb();
    await db.execute({ sql: "UPDATE gestiones SET estado_promesa=? WHERE gestion_id=?", args: [estado, gestionId] });
  },
  async promesasPendientes(clienteId) {
    const db = await getDb();
    const rs = clienteId
      ? await db.execute({ sql: "SELECT * FROM gestiones WHERE estado_promesa='pendiente' AND cliente_id=? ORDER BY gestion_id", args: [clienteId] })
      : await db.execute("SELECT * FROM gestiones WHERE estado_promesa='pendiente' ORDER BY gestion_id");
    return rs.rows.map(rowToGestion);
  },
  async contactosIniciales(clienteId, desdeIso) {
    const db = await getDb();
    const r = await db.execute({
      sql: "SELECT COUNT(*) n FROM gestiones WHERE cliente_id=? AND accion='contacto_inicial' AND fecha >= ?",
      args: [clienteId, desdeIso],
    });
    return Number(r.rows[0].n);
  },
};

export const sqliteReglas: ReglaRepository = {
  async todas() {
    const db = await getDb();
    return (await db.execute("SELECT * FROM reglas ORDER BY regla_id")).rows.map((r) => ({
      regla_id: Number(r.regla_id), tipo: String(r.tipo), condicion: String(r.condicion), valor: String(r.valor), descripcion: String(r.descripcion),
    }));
  },
};

const rowToPago = (r: Row): Pago => ({
  pago_id: Number(r.pago_id), cliente_id: String(r.cliente_id), referencia: String(r.referencia), monto: Number(r.monto), fecha: String(r.fecha),
  origen: String(r.origen) as Pago["origen"], estado: String(r.estado) as Pago["estado"], promesa_id: num(r.promesa_id),
});

/** libSQL abre una conexión por transacción: las escrituras de pago se serializan en el proceso y se reintenta ante SQLITE_BUSY (otro proceso). */
let colaPagos: Promise<unknown> = Promise.resolve();
const esBusy = (e: unknown) => /SQLITE_BUSY|database is locked/i.test(e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e));
async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 4 || !esBusy(e)) throw e;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

export const sqlitePagos: PagoRepository = {
  registrar(p: NuevoPago): Promise<ResultadoPago> {
    const r = colaPagos.then(() => conReintento(() => registrarPago(p)));
    colaPagos = r.catch(() => undefined);
    return r;
  },
  async porCliente(id) {
    const db = await getDb();
    return (await db.execute({ sql: "SELECT * FROM pagos WHERE cliente_id=? ORDER BY pago_id", args: [id] })).rows.map(rowToPago);
  },
};

/** Idempotente por `referencia`. Solo `conciliacion_banco` descuenta saldo, dentro de una transacción y sin dejarlo negativo. */
async function registrarPago(p: NuevoPago): Promise<ResultadoPago> {
    const db = await getDb();
    if (!(p.monto > 0) || !Number.isFinite(p.monto)) return { estado: "rechazado", motivo: "El monto debe ser mayor que cero" };
    const dup = (await db.execute({ sql: "SELECT * FROM pagos WHERE referencia=?", args: [p.referencia] })).rows[0];
    if (dup) return { estado: "duplicado", pago: rowToPago(dup) };
    const tx = await db.transaction("write");
    try {
      const c = (await tx.execute({ sql: "SELECT saldo_deuda FROM cartera WHERE cliente_id=?", args: [p.cliente_id] })).rows[0];
      if (!c) { await tx.rollback(); return { estado: "rechazado", motivo: "El cliente no existe" }; }
      const saldo = Number(c.saldo_deuda);
      const confirmado = p.origen === "conciliacion_banco";
      if (confirmado && p.monto > saldo + 1e-9) { await tx.rollback(); return { estado: "rechazado", motivo: `El pago (${p.monto}) supera el saldo pendiente (${saldo})` }; }
      const fecha = new Date().toISOString();
      const r = await tx.execute({
        sql: "INSERT INTO pagos (cliente_id,referencia,monto,fecha,origen,estado,promesa_id) VALUES (?,?,?,?,?,?,?)",
        args: [p.cliente_id, p.referencia, p.monto, fecha, p.origen, confirmado ? "confirmado" : "simulado", p.promesa_id ?? null],
      });
      if (confirmado) await tx.execute({ sql: "UPDATE cartera SET saldo_deuda = ROUND(saldo_deuda - ?, 2) WHERE cliente_id=? AND saldo_deuda >= ?", args: [p.monto, p.cliente_id, p.monto] });
      await tx.commit();
      const pago: Pago = { pago_id: Number(r.lastInsertRowid), cliente_id: p.cliente_id, referencia: p.referencia, monto: p.monto, fecha, origen: p.origen,
        estado: confirmado ? "confirmado" : "simulado", promesa_id: p.promesa_id ?? null };
      return confirmado ? { estado: "aplicado", pago, saldo_restante: Math.round((saldo - p.monto) * 100) / 100 } : { estado: "simulado", pago };
    } catch (e) {
      try { await tx.rollback(); } catch { /* ya cerrada */ }
      // Carrera por la misma referencia: otro request ganó; se reporta como duplicado, no como error.
      const again = (await db.execute({ sql: "SELECT * FROM pagos WHERE referencia=?", args: [p.referencia] })).rows[0];
      if (again) return { estado: "duplicado", pago: rowToPago(again) };
      throw e;
    }
}

/** Telemetría real de llamadas al LLM. Nunca rompe el flujo si falla el registro. */
export async function registrarLlmCall(c: { cliente_id?: string | null; rol: string; modelo: string; latencia_ms: number; tokens_in: number | null; tokens_out: number | null; ok: boolean; error?: string }) {
  try {
    const db = await getDb();
    await db.execute({
      sql: "INSERT INTO llm_calls (fecha,cliente_id,rol,modelo,latencia_ms,tokens_in,tokens_out,ok,error) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [new Date().toISOString(), c.cliente_id ?? null, c.rol, c.modelo, Math.round(c.latencia_ms), c.tokens_in, c.tokens_out, c.ok ? 1 : 0, c.error?.slice(0, 300) ?? null],
    });
  } catch (e) {
    console.warn("[telemetria] no se pudo registrar la llamada:", e instanceof Error ? e.message : e);
  }
}

export const sqliteKpis: KpiRepository = {
  async kpis() {
    const db = await getDb();
    const q = async (sql: string) => (await db.execute(sql)).rows;
    const total = Number((await q("SELECT COUNT(*) n FROM cartera"))[0].n);
    const conv = Number((await q("SELECT COUNT(DISTINCT cliente_id) n FROM gestiones WHERE agente='gestor'"))[0].n);
    const prio = await q("SELECT prioridad p, COUNT(*) n FROM cartera WHERE prioridad IS NOT NULL GROUP BY prioridad");
    const pa = (k: string) => Number(prio.find((r) => r.p === k)?.n ?? 0);
    const pago = (await q(
      "SELECT grupo, COUNT(*) n, SUM(pago_a_tiempo) pagan FROM cartera WHERE prioridad='alta' AND pago_a_tiempo IS NOT NULL GROUP BY grupo",
    )).map((r) => ({ grupo: String(r.grupo) as "tratamiento" | "control", n: Number(r.n), pagan: Number(r.pagan ?? 0) }));
    const t = pago.find((x) => x.grupo === "tratamiento"), c = pago.find((x) => x.grupo === "control");
    const lift = t && c && t.n && c.n ? (t.pagan / t.n - c.pagan / c.n) * 100 : null;
    const pr = (await q(
      `SELECT COUNT(*) total, SUM(estado_promesa='cumplida') cumplidas, SUM(estado_promesa='cumplida_simulada') simuladas, SUM(estado_promesa='rota') rotas,
              SUM(estado_promesa='pendiente') pendientes, SUM(estado_promesa='cancelada') canceladas
       FROM gestiones WHERE accion='promesa'`,
    ))[0];
    const motivos = (await q(
      `SELECT motivo_no_pago m, COUNT(DISTINCT cliente_id) n FROM gestiones WHERE agente='gestor' AND motivo_no_pago IS NOT NULL
       GROUP BY motivo_no_pago ORDER BY n DESC`,
    )).map((r) => ({ motivo: String(r.m), n: Number(r.n) }));
    const der = Number((await q("SELECT COUNT(DISTINCT cliente_id) n FROM gestiones WHERE derivado_humano=1 AND (agente='gestor' OR accion='escalar')"))[0].n);

    // Estados de contacto derivados de gestiones (misma función que usa la UI).
    const todas = (await q("SELECT * FROM gestiones ORDER BY cliente_id, gestion_id")).map(rowToGestion);
    const porCliente = new Map<string, Gestion[]>();
    for (const g of todas) (porCliente.get(g.cliente_id) ?? porCliente.set(g.cliente_id, []).get(g.cliente_id)!).push(g);
    let programados = 0;
    for (const gs of porCliente.values()) if (estadoCaso(gs).contacto === "programado") programados++;
    const sinResp = Number((await q("SELECT COUNT(DISTINCT cliente_id) n FROM gestiones WHERE accion='sin_respuesta'"))[0].n);
    const reint = Number((await q("SELECT COUNT(*) n FROM gestiones WHERE accion='programar_contacto' AND resultado='reintento'"))[0].n);

    const pg = await q("SELECT estado, COUNT(*) n, SUM(monto) m FROM pagos GROUP BY estado");
    const pp = (e: string) => ({ n: Number(pg.find((r) => r.estado === e)?.n ?? 0), monto: Number(pg.find((r) => r.estado === e)?.m ?? 0) });

    const lc = (await q(
      `SELECT COUNT(*) n, SUM(ok=0) fallidas, SUM(tokens_in) ti, SUM(tokens_out) [to], AVG(CASE WHEN ok=1 THEN latencia_ms END) lat FROM llm_calls`,
    ))[0];
    const porRol = (await q(
      `SELECT rol, modelo, COUNT(*) n, SUM(tokens_in) ti, SUM(tokens_out) [to] FROM llm_calls GROUP BY rol, modelo ORDER BY n DESC`,
    )).map((r) => ({ rol: String(r.rol), modelo: String(r.modelo), llamadas: Number(r.n), tokensIn: num(r.ti), tokensOut: num(r.to) }));
    const conLlm = Number((await q("SELECT COUNT(DISTINCT cliente_id) n FROM gestiones WHERE motor='llm'"))[0].n);
    const canales = (await q("SELECT canal, COUNT(*) n FROM gestiones WHERE accion='contacto_inicial' AND canal IS NOT NULL GROUP BY canal ORDER BY n DESC"))
      .map((r) => ({ canal: String(r.canal), contactos: Number(r.n) }));
    return {
      totalClientes: total, conversaciones: conv, prioridad: { alta: pa("alta"), media: pa("media"), baja: pa("baja") },
      pagoAltoRiesgo: pago, liftPp: lift,
      promesas: { total: Number(pr.total ?? 0), cumplidas: Number(pr.cumplidas ?? 0), cumplidasSimuladas: Number(pr.simuladas ?? 0), rotas: Number(pr.rotas ?? 0),
        pendientes: Number(pr.pendientes ?? 0), canceladas: Number(pr.canceladas ?? 0) },
      gestion: { contactosProgramados: programados, sinRespuesta: sinResp, escalados: der, reintentos: reint },
      pagos: { simulados: pp("simulado"), confirmados: pp("confirmado") },
      llm: { llamadas: Number(lc.n ?? 0), fallidas: Number(lc.fallidas ?? 0), tokensIn: num(lc.ti), tokensOut: num(lc.to), latenciaMediaMs: num(lc.lat), porRol,
        casosConLlm: conLlm, casosSinLlm: Math.max(conv - conLlm, 0) },
      canales,
      motivos, derivados: { derivados: der, conversaciones: conv },
    };
  },
};
