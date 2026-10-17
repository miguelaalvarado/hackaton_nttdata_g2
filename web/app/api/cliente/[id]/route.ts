import { NextResponse } from "next/server";
import { enmascararCelular } from "@/lib/auth";
import { getCtx, repos } from "@/lib/container";
import { estadoCaso } from "@/lib/core/estado";
import { historialDe } from "@/lib/core/orquestador";
import { motivosBloqueo } from "@/lib/core/reglas";
import { idCliente } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idCliente.safeParse(id).success) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  await getCtx();
  const c = await repos.cartera.get(id);
  if (!c) return NextResponse.json({ error: "no existe" }, { status: 404 });
  const { sim_escenario: _e, sim_pago_base: _b, celular, ...publico } = c;
  const gestiones = await repos.gestiones.porCliente(id);
  const reglas = await repos.reglas.todas();
  return NextResponse.json({
    cliente: { ...publico, celular: enmascararCelular(celular) },
    gestiones,
    conversacion: historialDe(gestiones),
    estado: estadoCaso(gestiones, motivosBloqueo(reglas)),
    pagos: await repos.pagos.porCliente(id),
  });
}
