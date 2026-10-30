import { startQueue, startWorker } from '@acompana/db/services';
import { buildApp } from './app';

const app = await buildApp();
if (process.env.WORKER_IN_PROCESS === 'true') {
  // Despliegue de un solo servicio: la API también procesa la cola.
  await startWorker();
} else if (process.env.QUEUE_ENABLED !== 'false') {
  // La API solo encola (reintentos y diferidos); el worker procesa.
  await startQueue();
}
await app.listen({ port: Number(process.env.PORT ?? process.env.API_PORT ?? 4000), host: '0.0.0.0' });
