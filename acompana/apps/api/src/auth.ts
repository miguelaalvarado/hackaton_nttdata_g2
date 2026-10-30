import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@acompana/db';

export type Role = 'BECARIO' | 'MENTOR' | 'TUTOR' | 'COORDINADOR';

export interface AuthUser {
  sub: string;
  name: string;
  role: Role;
  specialty: 'ACADEMICO' | 'PSICOLOGIA' | null;
  /** null = alcance Pronabec (todas las universidades). */
  universityId: string | null;
  scholarId: string | null;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** preHandler: exige token válido y uno de los roles. La autorización se valida siempre en la API. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ code: 'NO_AUTENTICADO', message: 'Inicia sesión.' });
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return reply.code(403).send({ code: 'SIN_PERMISO', message: 'Tu rol no tiene acceso a este recurso.' });
    }
  };
}

/** Filtro Prisma de becarios visibles para un usuario del equipo. */
export function scholarScope(u: AuthUser) {
  if (u.role === 'BECARIO') return { id: u.scholarId ?? '__none__' };
  if (u.role === 'MENTOR') return { mentors: { some: { mentorId: u.sub, active: true } } };
  return u.universityId ? { universityId: u.universityId } : {};
}

/** Becario concreto dentro del alcance. AND evita que el alcance sobrescriba el id (p. ej. el de otro becario). */
export function scholarWhere(u: AuthUser, scholarId: string) {
  return { AND: [{ id: scholarId }, scholarScope(u)] };
}

/** Lanza 403 si el usuario no puede ver a ese becario. */
export async function assertCanSee(u: AuthUser, scholarId: string) {
  const found = await prisma.scholar.findFirst({ where: scholarWhere(u, scholarId), select: { id: true } });
  if (!found) throw new HttpError(403, 'SIN_PERMISO', 'No tienes acceso a este becario.');
  await prisma.auditLog.create({ data: { actorId: u.sub, action: 'VER', entity: 'Scholar', entityId: scholarId } });
}
