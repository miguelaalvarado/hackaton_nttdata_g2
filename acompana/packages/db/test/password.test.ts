import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/services/password';

describe('contraseñas', () => {
  it('se guardan con sal y se verifican; nunca en texto plano', () => {
    const h = hashPassword('Acompana2026', 1000);
    expect(h).not.toContain('Acompana2026');
    expect(h).not.toBe(hashPassword('Acompana2026', 1000));
    expect(verifyPassword('Acompana2026', h)).toBe(true);
    expect(verifyPassword('otra', h)).toBe(false);
    expect(verifyPassword('Acompana2026', null)).toBe(false);
  });
});
