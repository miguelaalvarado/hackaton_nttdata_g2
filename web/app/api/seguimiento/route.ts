import { getCtx } from "@/lib/container";
import { seguimientoCliente } from "@/lib/core/seguimiento";
import { ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { clienteId } = (await req.json()) as { clienteId: string };
  const ctx = await getCtx();
  return ndjson(seguimientoCliente(ctx, clienteId));
}
