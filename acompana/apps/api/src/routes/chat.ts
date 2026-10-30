import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isWindowOpen } from '@acompana/domain';
import { prisma } from '@acompana/db';
import { conversationState, currentWeek, getProvider, handleInbound } from '@acompana/db/services';
import { assertCanSee, HttpError, requireRole } from '../auth';

/** Simulador de WhatsApp: mismo pipeline y mismas políticas que el canal real. */
export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireRole());

  app.get('/chat/:scholarId', async (req) => {
    const { scholarId } = z.object({ scholarId: z.string() }).parse(req.params);
    await assertCanSee(req.user, scholarId);
    const conv = await prisma.conversation.findUnique({
      where: { scholarId },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
    });
    const state = await conversationState(scholarId);
    const { now } = await currentWeek();
    const isScholar = req.user.role === 'BECARIO';
    return {
      provider: getProvider().name,
      state: {
        optIn: state.optIn,
        optedOutAt: state.optedOutAt,
        windowOpen: isWindowOpen(state.lastInboundAt, now),
        windowClosesAt: state.lastInboundAt ? new Date(state.lastInboundAt.getTime() + 24 * 3600_000) : null,
        platformSentToday: state.platformSentAt.length,
      },
      // El becario no ve los mensajes bloqueados por políticas (nunca le llegaron); el equipo sí, con el motivo.
      messages: (conv?.messages ?? [])
        .filter((m) => !isScholar || m.status !== 'BLOQUEADO')
        .map((m) => ({
          id: m.id,
          direction: m.direction,
          initiator: m.initiator,
          kind: m.kind,
          templateName: m.templateName,
          category: m.category,
          body: m.body,
          status: m.status,
          policyDecision: isScholar ? undefined : m.policyDecision,
          errorCode: isScholar ? undefined : m.errorCode,
          scheduledFor: m.scheduledFor,
          createdAt: m.createdAt,
        })),
    };
  });

  /** Mensaje entrante desde el teléfono simulado. Solo el propio becario. */
  app.post('/chat/:scholarId/inbound', async (req) => {
    const { scholarId } = z.object({ scholarId: z.string() }).parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
    if (req.user.role !== 'BECARIO' || req.user.scholarId !== scholarId) {
      throw new HttpError(403, 'SIN_PERMISO', 'Solo el becario puede escribir desde su teléfono.');
    }
    return handleInbound(scholarId, text, 'simulator');
  });
}
