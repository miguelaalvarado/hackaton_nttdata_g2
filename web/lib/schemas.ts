import { z } from "zod";

/** Validación de TODAS las entradas HTTP. Los errores devuelven solo los nombres de los campos, no detalles internos. */
export const idCliente = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "id inválido");
const modo = z.enum(["llm", "scripted"]);
const textoCliente = z.string().trim().min(1).max(400);

export const cicloBody = z.object({
  clienteId: idCliente,
  modo: modo.optional(),
  fase: z.enum(["planificar", "ejecutar", "todo"]).default("todo"),
  silencio: z.boolean().optional(),
  respuestasCliente: z.array(textoCliente).max(3).optional(),
}).strict();

export const humanoBody = z.object({
  clienteId: idCliente,
  accion: z.enum(["enviar", "cerrar", "levantar_bloqueo"]),
  mensaje: z.string().trim().max(1000).optional(),
  nota: z.string().trim().max(500).optional(),
  modo: modo.optional(),
  silencio: z.boolean().optional(),
  respuestasCliente: z.array(textoCliente).max(1).optional(),
}).strict().refine((b) => b.accion !== "enviar" || (b.mensaje?.length ?? 0) >= 5, { message: "mensaje requerido", path: ["mensaje"] });

export const seguimientoBody = z.object({ clienteId: idCliente }).strict();

export const adminBody = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("lote"), n: z.number().int().min(1).max(200).default(30) }).strict(),
  z.object({ accion: z.literal("cierre") }).strict(),
  z.object({ accion: z.literal("reset"), confirmar: z.literal("REINICIAR") }).strict(),
]);

export const pagoBody = z.object({
  clienteId: idCliente,
  referencia: z.string().trim().regex(/^[A-Za-z0-9_.:-]{3,64}$/, "referencia inválida"),
  monto: z.number().positive().max(10_000_000).finite(),
}).strict();

const MAX_BYTES = 20_000;

/** Lee y valida el JSON de la petición. Devuelve los datos o una Response 400/413 lista para retornar. */
export async function leerJson<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const fallo = (status: number, error: string, campos?: string[]) => ({ ok: false as const, res: Response.json({ error, campos }, { status, headers: { "cache-control": "no-store" } }) });
  // Un POST «simple» entre sitios (text/plain) no dispara preflight CORS: solo se aceptan cuerpos application/json.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fallo(415, "Se requiere Content-Type: application/json");
  const txt = await req.text();
  if (txt.length > MAX_BYTES) return fallo(413, "Solicitud demasiado grande");
  let json: unknown;
  try { json = JSON.parse(txt); } catch { return fallo(400, "JSON inválido"); }
  const r = schema.safeParse(json);
  if (!r.success) return fallo(400, "Solicitud inválida", [...new Set(r.error.issues.map((i) => i.path.join(".") || "(raíz)"))]);
  return { ok: true, data: r.data };
}

export const errorInterno = (e: unknown, ctx: string) => {
  console.error(`[${ctx}]`, e instanceof Error ? e.stack ?? e.message : e);
  return Response.json({ error: "Error interno" }, { status: 500, headers: { "cache-control": "no-store" } });
};
