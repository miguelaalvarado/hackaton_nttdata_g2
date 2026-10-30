import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_LOGIN_GUARD, isLocked, isValidDni, normalizeDni, registerAttempt, type LoginAttemptState } from '@acompana/domain';
import { prisma } from '@acompana/db';
import { verifyPassword } from '@acompana/db/services';
import { requireRole, type AuthUser } from '../auth';

/** Intentos por DNI. En memoria: suficiente para el MVP de una instancia; en producción va a un almacén compartido. */
const attempts = new Map<string, LoginAttemptState>();

export async function authRoutes(app: FastifyInstance) {
  /**
   * Cuentas de prueba (datos ficticios) para la pantalla de ingreso de la demo.
   * Desactivar en producción con DEMO_ACCOUNTS=false.
   */
  app.get('/auth/demo-users', async (_req, reply) => {
    if (process.env.DEMO_ACCOUNTS === 'false') return reply.code(404).send({ code: 'NO_DISPONIBLE', message: 'No disponible.' });
    const users = await prisma.user.findMany({
      where: { isDemo: true, dni: { not: null } },
      include: { scholar: { select: { persona: true } }, university: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    return users.map((u) => ({
      dni: u.dni,
      name: u.name,
      role: u.role,
      specialty: u.specialty,
      university: u.university?.name ?? 'Pronabec (todas)',
      persona: u.scholar?.persona ?? null,
    }));
  });

  /** Ingreso con DNI + contraseña. Mensaje de error único para no revelar si el DNI existe. */
  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ dni: z.string().max(20), password: z.string().min(1).max(200) }).parse(req.body);
    const dni = normalizeDni(body.dni);
    if (!isValidDni(dni)) return reply.code(400).send({ code: 'DNI_INVALIDO', message: 'El DNI debe tener 8 dígitos.' });
    const now = Date.now();
    if (isLocked(attempts.get(dni), now)) {
      return reply.code(429).send({
        code: 'INGRESO_BLOQUEADO',
        message: `Demasiados intentos. Vuelve a intentarlo en ${DEFAULT_LOGIN_GUARD.lockMinutes} minutos o pide ayuda a tu coordinador.`,
      });
    }
    const u = await prisma.user.findUnique({ where: { dni }, include: { scholar: true } });
    const ok = Boolean(u) && verifyPassword(body.password, u!.passwordHash);
    attempts.set(dni, registerAttempt(attempts.get(dni), ok, now));
    if (!ok || !u) return reply.code(401).send({ code: 'CREDENCIALES_INVALIDAS', message: 'DNI o contraseña incorrectos.' });

    await prisma.auditLog.create({ data: { actorId: u.id, action: 'INGRESO', entity: 'User', entityId: u.id } });
    const payload: AuthUser = {
      sub: u.id,
      name: u.name,
      role: u.role,
      specialty: u.specialty,
      universityId: u.universityId,
      scholarId: u.scholar?.id ?? null,
    };
    return { token: app.jwt.sign(payload, { expiresIn: '12h' }), user: payload };
  });

  app.get('/me', { preHandler: requireRole() }, async (req) => req.user);
}
