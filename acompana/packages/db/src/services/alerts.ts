import { registerFirstAction } from '@acompana/domain';
import { prisma, type ActionType } from '../index';
import { demoNow } from './clock';

/** Registra una acción humana. La primera fija si se cumplió el plazo (48 h en rojas). */
export async function addAlertAction(alertId: string, actorId: string, type: ActionType, note: string) {
  const now = await demoNow();
  const alert = await prisma.alert.findUniqueOrThrow({ where: { id: alertId } });
  const first = registerFirstAction(alert, now);
  const close = type === 'CIERRE';
  const [action] = await prisma.$transaction([
    prisma.alertAction.create({ data: { alertId, actorId, type, note, at: now } }),
    prisma.alert.update({
      where: { id: alertId },
      data: {
        firstActionAt: first.firstActionAt,
        slaMet: first.slaMet,
        status: close ? 'CERRADA' : 'EN_ATENCION',
        closedAt: close ? now : null,
      },
    }),
  ]);
  return action;
}
