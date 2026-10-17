import { getCtx } from "@/lib/container";
import { ciclo } from "@/lib/core/orquestador";
import { ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const { clienteId, modo } = (await req.json()) as { clienteId: string; modo?: "llm" | "scripted" };
  const ctx = await getCtx(modo);
  return ndjson(ciclo(ctx, clienteId));
}
