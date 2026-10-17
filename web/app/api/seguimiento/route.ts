import { getCtx } from "@/lib/container";
import { seguimientoCliente } from "@/lib/core/seguimiento";
import { errorInterno, leerJson, seguimientoBody } from "@/lib/schemas";
import { ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";

/** SIMULACIÓN: avanza al día de la promesa. No concilia pagos reales. */
export async function POST(req: Request) {
  const b = await leerJson(req, seguimientoBody);
  if (!b.ok) return b.res;
  try {
    const ctx = await getCtx("scripted");
    return ndjson(seguimientoCliente(ctx, b.data.clienteId));
  } catch (e) {
    return errorInterno(e, "seguimiento");
  }
}
