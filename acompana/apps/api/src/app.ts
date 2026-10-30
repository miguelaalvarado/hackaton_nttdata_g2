import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { HttpErrorLike } from '@acompana/db/services';
import { HttpError } from './auth';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { panelRoutes } from './routes/panel';
import { scholarRoutes } from './routes/scholar';

export async function buildApp() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Falta JWT_SECRET (ver .env.example)');

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','), credentials: false });
  await app.register(jwt, { secret });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: 'DATOS_INVALIDOS', message: 'Datos inválidos', issues: err.issues });
    if (err instanceof HttpError || err instanceof HttpErrorLike) return reply.code(err.status).send({ code: err.code, message: err.message });
    if ((err as { code?: string }).code === 'P2025') return reply.code(404).send({ code: 'NO_ENCONTRADO', message: 'Recurso no encontrado' });
    app.log.error(err);
    return reply.code(500).send({ code: 'ERROR_INTERNO', message: 'Ocurrió un error inesperado.' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(scholarRoutes);
  await app.register(chatRoutes);
  await app.register(panelRoutes);
  return app;
}
