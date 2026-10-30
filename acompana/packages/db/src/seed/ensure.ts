/** Siembra solo si la base está vacía (arranque con Docker). Para reiniciar la demo: npm run db:seed. */
import { prisma } from '../index';

const count = await prisma.scholar.count().catch(() => 0);
await prisma.$disconnect();
if (count > 0) {
  console.log(`Base con ${count} becarios: no se vuelve a sembrar.`);
} else {
  await import('./index');
}
