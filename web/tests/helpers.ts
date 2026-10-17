import { getDb, resetDb } from "@/lib/adapters/sqlite";
import { getCtx, reiniciarCache } from "@/lib/container";
import type { Ctx } from "@/lib/core/orquestador";
import type { Cliente, EventoAgente, EventoStream } from "@/lib/core/types";

/** Miércoles 14-oct-2026 10:00 (hora local): día hábil dentro del horario. */
export const AHORA = new Date(2026, 9, 14, 10, 0, 0);

export async function reiniciar() {
  await resetDb();
  reiniciarCache();
}

export async function ctxTest(over: Partial<Ctx> = {}): Promise<Ctx> {
  const base = await getCtx("scripted");
  return { ...base, ahora: () => AHORA, ...over };
}

export async function crearCliente(o: Partial<Cliente> = {}): Promise<Cliente> {
  const c: Cliente = {
    cliente_id: "T0001", nombre: "Ana Prueba", celular: "987654321", canal_preferido: "whatsapp", hora_respuesta: "12-14", producto: "préstamo personal",
    saldo_deuda: 850, monto_cuota: 400, fecha_vencimiento: "2026-10-04", dias_atraso: 10, dia_abono_sueldo: 30, sueldo_llego_mes: true, saldo_cuenta: 100,
    uso_linea_tc_pct: 50, atrasos_ult_6m: 0, prob_no_pago: null, causa_probable: null, prioridad: null, grupo: "tratamiento", pago_a_tiempo: null,
    sim_escenario: "iliquidez", sim_pago_base: false, ...o,
  };
  const db = await getDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO cartera (cliente_id,nombre,celular,canal_preferido,hora_respuesta,producto,saldo_deuda,monto_cuota,fecha_vencimiento,dias_atraso,
          dia_abono_sueldo,sueldo_llego_mes,saldo_cuenta,uso_linea_tc_pct,atrasos_ult_6m,grupo,sim_escenario,sim_pago_base) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [c.cliente_id, c.nombre, c.celular, c.canal_preferido, c.hora_respuesta, c.producto, c.saldo_deuda, c.monto_cuota, c.fecha_vencimiento, c.dias_atraso,
      c.dia_abono_sueldo, c.sueldo_llego_mes ? 1 : 0, c.saldo_cuenta, c.uso_linea_tc_pct, c.atrasos_ult_6m, c.grupo, c.sim_escenario, c.sim_pago_base ? 1 : 0],
  });
  return c;
}

export async function correr(gen: AsyncGenerator<EventoStream>) {
  const eventos: EventoAgente[] = [];
  let fin: Extract<EventoStream, { tipo: "fin" }> | null = null;
  for await (const m of gen) (m.tipo === "evento" ? eventos.push(m.evento) : (fin = m));
  return { eventos, fin: fin! };
}

export const textos = (evs: EventoAgente[]) => evs.map((e) => `${e.titulo} ${e.texto ?? ""}`).join("\n");
