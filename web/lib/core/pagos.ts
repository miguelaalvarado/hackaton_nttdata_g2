import type { Ctx } from "./orquestador";
import type { ResultadoPago } from "./types";

/**
 * Evento de pago CONFIRMADO (conciliación). Es la única vía que descuenta saldo.
 * Idempotente por `referencia`, atómico y sin saldos negativos (lo garantiza PagoRepository).
 * Efectos: marca como cumplidas las promesas cubiertas y cancela el seguimiento obsoleto si la deuda queda saldada.
 */
export async function confirmarPago(ctx: Ctx, i: { clienteId: string; referencia: string; monto: number }): Promise<{ resultado: ResultadoPago; efectos: string[] }> {
  const resultado = await ctx.pagos.registrar({ cliente_id: i.clienteId, referencia: i.referencia, monto: i.monto, origen: "conciliacion_banco" });
  const efectos: string[] = [];
  if (resultado.estado !== "aplicado") return { resultado, efectos };

  let restante = resultado.pago.monto;
  for (const p of await ctx.gestiones.promesasPendientes(i.clienteId)) {
    if ((p.monto_promesa ?? Infinity) <= restante + 1e-9) {
      restante -= p.monto_promesa ?? 0;
      await ctx.gestiones.actualizarPromesa(p.gestion_id, "cumplida");
      efectos.push(`Promesa #${p.gestion_id} cumplida con pago confirmado`);
    }
  }
  const base = { cliente_id: i.clienteId, canal: null, mensaje: null, motivo_no_pago: null, monto_promesa: null, fecha_promesa: null, estado_promesa: null, derivado_humano: false } as const;
  await ctx.gestiones.insertar({ ...base, agente: "supervisor", accion: "pago_confirmado", resultado: "pago_confirmado", origen: "conciliacion_banco", aprobacion: "no_aplica", motor: "reglas",
    justificacion: `Pago ${resultado.pago.referencia} confirmado por S/ ${resultado.pago.monto}. Saldo restante S/ ${resultado.saldo_restante}.` });
  if (resultado.saldo_restante <= 0) {
    for (const p of await ctx.gestiones.promesasPendientes(i.clienteId)) {
      await ctx.gestiones.actualizarPromesa(p.gestion_id, "cancelada");
      efectos.push(`Promesa #${p.gestion_id} cancelada: la deuda quedó saldada`);
    }
    await ctx.gestiones.insertar({ ...base, agente: "supervisor", accion: "cierre_por_pago", resultado: "cerrado", origen: "supervisor", aprobacion: "no_aplica", motor: "reglas",
      justificacion: "Deuda saldada: se cancelan seguimientos y contactos pendientes." });
    efectos.push("Caso cerrado por pago total");
  }
  return { resultado, efectos };
}
