import { describe, expect, it } from 'vitest';
import { isLocked, isValidDni, normalizeDni, registerAttempt } from '../src';

describe('ingreso con DNI', () => {
  it('valida DNI de 8 dígitos y normaliza espacios o guiones', () => {
    expect(isValidDni('99000101')).toBe(true);
    expect(isValidDni(' 9900-0101 ')).toBe(true);
    expect(normalizeDni(' 9900-0101 ')).toBe('99000101');
    expect(isValidDni('1234567')).toBe(false);
    expect(isValidDni('123456789')).toBe(false);
    expect(isValidDni('abcdefgh')).toBe(false);
  });

  it('bloquea 15 minutos tras 5 intentos fallidos y un ingreso correcto reinicia', () => {
    let s = undefined as ReturnType<typeof registerAttempt> | undefined;
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) s = registerAttempt(s, false, t0);
    expect(isLocked(s, t0)).toBe(false);
    s = registerAttempt(s, false, t0);
    expect(isLocked(s, t0 + 60_000)).toBe(true);
    expect(isLocked(s, t0 + 15 * 60_000 + 1)).toBe(false);
    expect(registerAttempt({ failures: 3, lockedUntil: null }, true, t0)).toEqual({ failures: 0, lockedUntil: null });
  });
});
