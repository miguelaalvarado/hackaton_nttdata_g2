import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@acompana/db';
import { requireRole, type AuthUser } from '../auth';

export async function authRoutes(app: FastifyInstance) {
  /** Usuarios de demostración (login sin contraseña: solo para la demo con datos sintéticos). */
  app.get('/auth/demo-users', async () => {
    const users = await prisma.user.findMany({
      where: { isDemo: true },
      include: { scholar: { select: { id: true, persona: true } }, university: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      specialty: u.specialty,
      university: u.university?.name ?? 'Pronabec (todas)',
      persona: u.scholar?.persona ?? null,
    }));
  });

  app.post('/auth/demo-login', async (req, reply) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    const u = await prisma.user.findFirst({ where: { id: userId, isDemo: true }, include: { scholar: true } });
    if (!u) return reply.code(404).send({ code: 'USUARIO_NO_ENCONTRADO', message: 'Usuario de demo no encontrado.' });
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
