import { exigirAdmin } from "@/lib/auth";
import { getCtx } from "@/lib/container";
import { turnoHumano } from "@/lib/core/orquestador";
import { errorInterno, humanoBody, leerJson } from "@/lib/schemas";
import { conAviso, ndjson } from "@/lib/stream";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Acciones del asesor humano: solo con acceso de administración, y el orquestador exige que el caso esté derivado. */
export async function POST(req: Request) {
  const no = exigirAdmin(req);
  if (no) return no;
  const b = await leerJson(req, humanoBody);
  if (!b.ok) return b.res;
  try {
    const ctx = await getCtx(b.data.modo);
    const { clienteId, accion, mensaje, nota, silencio, respuestasCliente } = b.data;
    return ndjson(conAviso(ctx, turnoHumano(ctx, clienteId, { accion, mensaje, nota }, { silencio, respuestasCliente })));
  } catch (e) {
    return errorInterno(e, "humano");
  }
}
