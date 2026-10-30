import PgBoss from 'pg-boss';
import { configureMessaging, type DeliveryScheduler } from './outbound';

export const QUEUES = {
  deliver: 'deliver-message',
  weeklyRecalc: 'weekly-recalc',
  classReminders: 'class-reminders',
  weeklyCheckin: 'weekly-checkin',
  dueSweep: 'due-messages-sweep',
} as const;

/** Cola sobre PostgreSQL (pg-boss): sin Redis, un contenedor menos. */
export async function startQueue(connectionString = process.env.DATABASE_URL!): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString });
  boss.on('error', (e) => console.error('[pg-boss]', e));
  await boss.start();
  for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  const scheduler: DeliveryScheduler = {
    async schedule(messageId, runAt) {
      // Los reintentos los decide deliverMessage (backoff propio); el job solo dispara la entrega a la hora indicada.
      await boss.send(QUEUES.deliver, { messageId }, { startAfter: runAt, singletonKey: `${messageId}:${runAt.getTime()}` });
    },
  };
  configureMessaging({ scheduler });
  return boss;
}
