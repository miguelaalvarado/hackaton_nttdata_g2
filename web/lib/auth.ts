import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Control de acceso PROPORCIONADO al MVP (no es un sistema de identidad bancario).
 * TODA operación que modifica estado o gasta tokens exige NEXO_ADMIN_TOKEN (cabecera x-admin-token o Bearer), en TODOS los entornos:
 *  - Sin token configurado en el servidor: las operaciones quedan DESHABILITADAS (falla cerrado), también en desarrollo.
 *  - No se autoriza por la cabecera Host (falsificable) ni por «venir de localhost».
 *  - CSRF: la cabecera personalizada obliga a un preflight CORS que este servidor no concede, y los cuerpos deben ser application/json.
 * El token lo escribe quien administra y vive en sessionStorage del navegador: nunca en el bundle ni en NEXT_PUBLIC_*.
 */
export type Acceso = { ok: true } | { ok: false; status: 401 | 403; error: string };

const hash = (s: string) => createHash("sha256").update(s).digest();

export function autorizarAdmin(req: Request): Acceso {
  const token = process.env.NEXO_ADMIN_TOKEN?.trim();
  if (!token) return { ok: false, status: 403, error: "Las acciones de administración están deshabilitadas: configura NEXO_ADMIN_TOKEN en el servidor" };
  const auth = req.headers.get("authorization");
  const dado = req.headers.get("x-admin-token") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
  if (dado && timingSafeEqual(hash(dado), hash(token))) return { ok: true };
  return { ok: false, status: 401, error: "Se requiere el token de administración" };
}

/** Responde 401/403 si no hay acceso; null si puede continuar. */
export function exigirAdmin(req: Request): Response | null {
  const a = autorizarAdmin(req);
  return a.ok ? null : Response.json({ error: a.error }, { status: a.status, headers: { "cache-control": "no-store" } });
}

/** 98•••••85: el número completo no sale por la API. */
export const enmascararCelular = (c: string) => (c.length <= 4 ? "••••" : `${c.slice(0, 2)}${"•".repeat(Math.max(c.length - 4, 3))}${c.slice(-2)}`);
