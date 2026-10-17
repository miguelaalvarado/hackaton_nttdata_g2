"use client";

export async function adminPost(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Mensaje comprensible para un error HTTP de la API. */
export async function errorDe(r: Response): Promise<string> {
  try {
    const d = (await r.json()) as { error?: string; campos?: string[] };
    return d.error ? `${d.error}${d.campos?.length ? ` (${d.campos.join(", ")})` : ""}` : `Error ${r.status}`;
  } catch {
    return `Error ${r.status}`;
  }
}
