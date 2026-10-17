import { NextResponse } from "next/server";
import { resetDb } from "@/lib/adapters/sqlite";
import { getCtx, reiniciarCache } from "@/lib/container";
import { cerrarMes, procesarLote } from "@/lib/core/seguimiento";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Acciones de demo: lote sin LLM, cierre de mes simulado y reinicio de la base. */
export async function POST(req: Request) {
  try {
    const { accion, n = 30 } = (await req.json()) as { accion: "lote" | "cierre" | "reset"; n?: number };
    if (accion === "reset") {
      await resetDb();
      reiniciarCache();
      return NextResponse.json({ ok: true });
    }
    const ctx = await getCtx("scripted"); // el lote usa reglas (sin LLM) para ser rápido y sin costo
    if (accion === "lote") return NextResponse.json(await procesarLote(ctx, Math.min(Math.max(n, 1), 200)));
    if (accion === "cierre") return NextResponse.json(await cerrarMes(ctx));
    return NextResponse.json({ error: "accion inválida" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
