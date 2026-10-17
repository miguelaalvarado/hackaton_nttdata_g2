"use client";

export const TOKEN_KEY = "nexo_admin_token";

/** El token lo escribe quien administra y vive solo en sessionStorage: no está en el bundle ni en variables NEXT_PUBLIC_*. */
export function adminHeaders(): Record<string, string> {
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    return t ? { "x-admin-token": t } : {};
  } catch {
    return {};
  }
}

export async function adminPost(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...adminHeaders() }, body: JSON.stringify(body) });
}

/** Mensaje comprensible para un error HTTP de la API. */
export async function errorDe(r: Response): Promise<string> {
  if (r.status === 401) return "Se requiere el token de administración (cuadro «Acceso de administración»).";
  if (r.status === 403) return "Acción deshabilitada en este servidor: falta configurar NEXO_ADMIN_TOKEN o no se accede desde localhost.";
  try {
    const d = (await r.json()) as { error?: string; campos?: string[] };
    return d.error ? `${d.error}${d.campos?.length ? ` (${d.campos.join(", ")})` : ""}` : `Error ${r.status}`;
  } catch {
    return `Error ${r.status}`;
  }
}
