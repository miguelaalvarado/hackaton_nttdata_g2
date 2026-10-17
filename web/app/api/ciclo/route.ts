import { getCtx } from "@/lib/container";
import { ciclo } from "@/lib/core/orquestador";
import { cicloBody, errorInterno, leerJson } from "@/lib/schemas";
import { conAviso, ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const b = await leerJson(req, cicloBody);
  if (!b.ok) return b.res;
  try {
    const ctx = await getCtx(b.data.modo);
    const { clienteId, fase, silencio, respuestasCliente } = b.data;
    return ndjson(conAviso(ctx, ciclo(ctx, clienteId, { fase, silencio, respuestasCliente })));
  } catch (e) {
    return errorInterno(e, "ciclo");
  }
}
