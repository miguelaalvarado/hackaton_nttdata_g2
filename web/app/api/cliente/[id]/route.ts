import { NextResponse } from "next/server";
import { repos } from "@/lib/container";
import { getCtx } from "@/lib/container";
import { historialDe } from "@/lib/core/orquestador";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await getCtx();
  const c = await repos.cartera.get(id);
  if (!c) return NextResponse.json({ error: "no existe" }, { status: 404 });
  const { sim_escenario: _e, sim_pago_base: _b, ...publico } = c;
  const gestiones = await repos.gestiones.porCliente(id);
  const ultima = [...gestiones].reverse().find((g) => g.agente === "gestor" || g.agente === "humano");
  return NextResponse.json({
    cliente: publico,
    gestiones,
    conversacion: historialDe(gestiones),
    esperandoHumano: !!ultima && ultima.agente === "gestor" && ultima.derivado_humano,
  });
}
