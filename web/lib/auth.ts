import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Control de acceso PROPORCIONADO al MVP (no es un sistema de identidad bancario).
 *  - Con NEXO_ADMIN_TOKEN: toda operación que modifica estado o gasta tokens exige ese token (cabecera x-admin-token o Bearer).
 *  - Sin token y NODE_ENV=production: las operaciones quedan DESHABILITADAS (falla cerrado).
 *  - Sin token en desarrollo: solo se aceptan peticiones dirigidas a localhost (demo local protegida).
 * El token nunca viaja en el bundle del frontend: lo escribe quien administra y vive en sessionStorage del navegador.
 */
export type Acceso = { ok: true } | { ok: false; status: 401 | 403; error: string };

const hash = (s: string) => createHash("sha256").update(s).digest();

export function autorizarAdmin(req: Request): Acceso {
  const token = process.env.NEXO_ADMIN_TOKEN?.trim();
  if (token) {
    const auth = req.headers.get("authorization");
    const dado = req.headers.get("x-admin-token") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
    if (dado && timingSafeEqual(hash(dado), hash(token))) return { ok: true };
    return { ok: false, status: 401, error: "Se requiere el token de administración" };
  }
  if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 403, error: "Las acciones de administración están deshabilitadas: configura NEXO_ADMIN_TOKEN" };
  }
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return { ok: true };
  return { ok: false, status: 403, error: "Sin NEXO_ADMIN_TOKEN solo se permite el acceso desde localhost" };
}

/** Responde 401/403 si no hay acceso; null si puede continuar. */
export function exigirAdmin(req: Request): Response | null {
  const a = autorizarAdmin(req);
  return a.ok ? null : Response.json({ error: a.error }, { status: a.status, headers: { "cache-control": "no-store" } });
}

/** 98•••••85: el número completo no sale por la API. */
export const enmascararCelular = (c: string) => (c.length <= 4 ? "••••" : `${c.slice(0, 2)}${"•".repeat(Math.max(c.length - 4, 3))}${c.slice(-2)}`);
