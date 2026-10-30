import { startQueue } from '@acompana/db/services';
import { buildApp } from './app';

const app = await buildApp();
if (process.env.QUEUE_ENABLED !== 'false') {
  // La API solo encola (reintentos y diferidos); el worker procesa.
  await startQueue();
}
await app.listen({ port: Number(process.env.API_PORT ?? 4000), host: '0.0.0.0' });
