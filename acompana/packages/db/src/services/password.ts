import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** PBKDF2-HMAC-SHA256, 600 000 iteraciones (recomendación OWASP vigente para PBKDF2-SHA256). */
const ITERATIONS = 600_000;

export function hashPassword(password: string, iterations = ITERATIONS): string {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, it, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), Number(it), expected.length, 'sha256');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
