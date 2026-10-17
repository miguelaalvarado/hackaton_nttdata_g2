import { NextResponse } from "next/server";
import { exigirAdmin } from "@/lib/auth";
import { getCtx } from "@/lib/container";
import { confirmarPago } from "@/lib/core/pagos";
import { errorInterno, leerJson, pagoBody } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/**
 * Evento de pago CONFIRMADO (conciliación bancaria). Solo con acceso de administración.
 * No existe integración bancaria real en este prototipo: este endpoint es el punto donde se conectaría.
 * Idempotente por `referencia`; un pago duplicado devuelve 200 con estado "duplicado" y NO vuelve a descontar.
 */
export async function POST(req: Request) {
  const no = exigirAdmin(req);
  if (no) return no;
  const b = await leerJson(req, pagoBody);
  if (!b.ok) return b.res;
  try {
    const ctx = await getCtx("scripted");
    const { resultado, efectos } = await confirmarPago(ctx, { clienteId: b.data.clienteId, referencia: b.data.referencia, monto: b.data.monto });
    if (resultado.estado === "rechazado") return NextResponse.json({ estado: "rechazado", motivo: resultado.motivo }, { status: 422 });
    return NextResponse.json({ estado: resultado.estado, referencia: resultado.pago.referencia, saldo_restante: "saldo_restante" in resultado ? resultado.saldo_restante : undefined, efectos });
  } catch (e) {
    return errorInterno(e, "pagos");
  }
}
