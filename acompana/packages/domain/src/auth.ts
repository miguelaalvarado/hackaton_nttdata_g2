/** Reglas de ingreso. El DNI identifica a la persona; la contraseña la autentica (el DNI solo no basta: lo conocen terceros). */

export function normalizeDni(input: string): string {
  return input.replace(/\D/g, '');
}

/** DNI peruano: 8 dígitos. */
export function isValidDni(input: string): boolean {
  return /^\d{8}$/.test(normalizeDni(input));
}

export interface LoginGuardConfig {
  maxFailures: number;
  lockMinutes: number;
}
export const DEFAULT_LOGIN_GUARD: LoginGuardConfig = { maxFailures: 5, lockMinutes: 15 };

export interface LoginAttemptState {
  failures: number;
  lockedUntil: number | null;
}

/** ¿Está bloqueado el ingreso para ese DNI en este momento? */
export function isLocked(s: LoginAttemptState | undefined, nowMs: number): boolean {
  return Boolean(s?.lockedUntil && s.lockedUntil > nowMs);
}

/** Nuevo estado tras un intento. Tras maxFailures fallos seguidos, bloquea lockMinutes. Un ingreso correcto reinicia el conteo. */
export function registerAttempt(s: LoginAttemptState | undefined, ok: boolean, nowMs: number, cfg: LoginGuardConfig = DEFAULT_LOGIN_GUARD): LoginAttemptState {
  if (ok) return { failures: 0, lockedUntil: null };
  const prev = s && (!s.lockedUntil || s.lockedUntil > nowMs) ? s : { failures: 0, lockedUntil: null };
  const failures = prev.failures + 1;
  return failures >= cfg.maxFailures ? { failures: 0, lockedUntil: nowMs + cfg.lockMinutes * 60_000 } : { failures, lockedUntil: null };
}
