import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

// =============================================================================
// Database Client
// =============================================================================

export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

// Log slow queries in development
prisma.$on('query', (e) => {
  if (e.duration > 100) {
    logger.warn({ duration: e.duration, query: e.query }, 'Slow query detected');
  }
});

prisma.$on('error', (e) => {
  logger.error({ error: e }, 'Prisma error');
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
