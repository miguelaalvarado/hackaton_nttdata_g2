import { NextResponse } from "next/server";
import { resetDb } from "@/lib/adapters/sqlite";
import { exigirAdmin } from "@/lib/auth";
import { getCtx, reiniciarCache } from "@/lib/container";
import { cerrarMes, procesarLote } from "@/lib/core/seguimiento";
import { adminBody, errorInterno, leerJson } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Acciones de demo (lote sin LLM, cierre de mes simulado, reinicio). Protegidas: ver lib/auth.ts. */
export async function POST(req: Request) {
  const no = exigirAdmin(req);
  if (no) return no;
  const b = await leerJson(req, adminBody);
  if (!b.ok) return b.res;
  try {
    if (b.data.accion === "reset") {
      await resetDb();
      reiniciarCache();
      return NextResponse.json({ ok: true });
    }
    const ctx = await getCtx("scripted"); // el lote usa reglas (sin LLM) para ser rápido y sin costo
    if (b.data.accion === "lote") return NextResponse.json(await procesarLote(ctx, b.data.n));
    return NextResponse.json(await cerrarMes(ctx));
  } catch (e) {
    return errorInterno(e, "admin");
  }
}
