import { describe, expect, it } from 'vitest';
import { scholarScope, scholarWhere, type AuthUser } from '../src/auth';

const base: AuthUser = { sub: 'u', name: 'x', role: 'BECARIO', specialty: null, universityId: 'U1', scholarId: 'sch-luis' };

describe('control de acceso por rol', () => {
  it('un becario no puede consultar a otro becario: el filtro conserva ambos criterios', () => {
    expect(scholarWhere(base, 'sch-rosa')).toEqual({ AND: [{ id: 'sch-rosa' }, { id: 'sch-luis' }] });
  });
  it('coordinador de universidad ve solo su universidad; Pronabec ve todo; mentor solo asignados', () => {
    expect(scholarScope({ ...base, role: 'COORDINADOR', scholarId: null })).toEqual({ universityId: 'U1' });
    expect(scholarScope({ ...base, role: 'COORDINADOR', universityId: null, scholarId: null })).toEqual({});
    expect(scholarScope({ ...base, role: 'MENTOR', sub: 'm1', scholarId: null })).toEqual({ mentors: { some: { mentorId: 'm1', active: true } } });
  });
});
