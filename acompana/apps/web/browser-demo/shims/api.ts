/** Sustituye a lib/api en la versión navegador: las mismas llamadas, resueltas por el backend en memoria. */
import { ApiError, getSession } from '../../lib/api';
import { handle, HttpError } from '../backend';

export * from '../../lib/api';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  try {
    // Ida y vuelta por JSON: misma forma de datos (fechas como texto) que la API real.
    const res = await handle(method, path, opts.body ? JSON.parse(JSON.stringify(opts.body)) : undefined, getSession()?.user ?? null);
    return JSON.parse(JSON.stringify(res ?? null)) as T;
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.status, e.code, e.message);
    console.error(e);
    throw new ApiError(500, 'ERROR_INTERNO', 'Ocurrió un error inesperado.');
  }
}
