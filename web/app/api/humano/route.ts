import { getCtx } from "@/lib/container";
import { turnoHumano } from "@/lib/core/orquestador";
import { ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const { clienteId, accion, mensaje, modo } = (await req.json()) as {
    clienteId: string; accion: "enviar" | "cerrar"; mensaje?: string; modo?: "llm" | "scripted";
  };
  const ctx = await getCtx(modo);
  return ndjson(turnoHumano(ctx, clienteId, { accion, mensaje }));
}
