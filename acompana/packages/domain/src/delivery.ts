/** Clasificación de errores de envío y política de reintentos. */

export type SendErrorClass = 'TRANSITORIO' | 'POLITICA' | 'PERMANENTE';

export interface SendError {
  /** Código del proveedor (Meta/AWS) o interno. */
  code: string;
  /** Clasificación ya resuelta por el adaptador del canal. */
  class: SendErrorClass;
  message: string;
}

/** Solo los errores transitorios se reintentan. Un rechazo por política nunca se reintenta. */
export function shouldRetry(err: SendError, attempt: number, maxAttempts: number): boolean {
  return err.class === 'TRANSITORIO' && attempt < maxAttempts;
}

/** Backoff exponencial con tope: base · 2^(intento-1). Jitter opcional en [0, 1). */
export function backoffDelayMs(attempt: number, baseMs = 2000, maxMs = 15 * 60_000, jitter = 0): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxMs, Math.round(raw * (1 + jitter * 0.25)));
}

/** Errores de límite de tasa y de calidad que se monitorean para alertar al coordinador. */
export function isRateOrQualityError(err: SendError): boolean {
  return /rate|limit|quality|spam|throttl/i.test(err.code) || /rate|limit|quality|spam|throttl/i.test(err.message);
}
