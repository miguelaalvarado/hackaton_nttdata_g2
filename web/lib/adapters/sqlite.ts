import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client as Libsql, type Row } from "@libsql/client";
import carteraSeed from "../../seed/cartera.json";
import reglasSeed from "../../seed/reglas.json";
import type { CarteraRepository, GestionRepository, KpiRepository, ReglaRepository } from "../core/ports";
import { isoDate, sumarDias } from "../core/reglas";
import type { Cliente, Gestion, NuevaGestion, Regla } from "../core/types";

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
];

type G = { __db?: Libsql; __dbReady?: Promise<Libsql> };
const g = globalThis as unknown as G;

export function dbUrl() {
  return process.env.DB_URL ?? "file:./data/cobranza.db";
}

async function seed(db: Libsql) {
  const n = Number((await db.execute("SELECT COUNT(*) n FROM cartera")).rows[0].n);
  if (n > 0) return;
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
    const db = createClient({ url });
    g.__db = db;
    for (const ddl of DDL) await db.execute(ddl);
    await seed(db);
    return db;
  })());
}

/** Borra todo y vuelve a cargar la semilla (botón "reiniciar demo"). */
export async function resetDb() {
  const db = await getDb();
  await db.batch(["DELETE FROM gestiones", "DELETE FROM sqlite_sequence WHERE name='gestiones'", "DELETE FROM cartera", "DELETE FROM reglas"], "write");
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
      sql: `INSERT INTO gestiones (cliente_id,fecha,agente,accion,canal,mensaje,resultado,motivo_no_pago,monto_promesa,fecha_promesa,estado_promesa,derivado_humano,justificacion)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [gs.cliente_id, fecha, gs.agente, gs.accion, gs.canal, gs.mensaje, gs.resultado, gs.motivo_no_pago, gs.monto_promesa,
        gs.fecha_promesa, gs.estado_promesa, gs.derivado_humano ? 1 : 0, gs.justificacion],
    });
    return { ...gs, fecha, gestion_id: Number(r.lastInsertRowid) };
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
      `SELECT COUNT(*) total, SUM(estado_promesa='cumplida') cumplidas, SUM(estado_promesa='rota') rotas, SUM(estado_promesa='pendiente') pendientes
       FROM gestiones WHERE accion='promesa'`,
    ))[0];
    const motivos = (await q(
      `SELECT motivo_no_pago m, COUNT(DISTINCT cliente_id) n FROM gestiones WHERE agente='gestor' AND motivo_no_pago IS NOT NULL
       GROUP BY motivo_no_pago ORDER BY n DESC`,
    )).map((r) => ({ motivo: String(r.m), n: Number(r.n) }));
    const der = Number((await q("SELECT COUNT(DISTINCT cliente_id) n FROM gestiones WHERE derivado_humano=1 AND agente='gestor'"))[0].n);
    return {
      totalClientes: total, conversaciones: conv, prioridad: { alta: pa("alta"), media: pa("media"), baja: pa("baja") },
      pagoAltoRiesgo: pago, liftPp: lift,
      promesas: { total: Number(pr.total ?? 0), cumplidas: Number(pr.cumplidas ?? 0), rotas: Number(pr.rotas ?? 0), pendientes: Number(pr.pendientes ?? 0) },
      motivos, derivados: { derivados: der, conversaciones: conv },
    };
  },
};
