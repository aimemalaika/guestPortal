import { Router, Request, Response, IRouter } from 'express';
import { omadaClient } from '../services/omada-client';
import { prisma } from '../db';
import { logger } from '../logger';

// =============================================================================
// Health Check Routes
// =============================================================================

export const healthRouter: IRouter = Router();

/**
 * GET /healthz
 * Basic health check - returns 200 if the server is running.
 */
healthRouter.get('/healthz', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /readyz
 * Readiness check - verifies all dependencies are available.
 */
healthRouter.get('/readyz', async (req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; latency?: number; error?: string }> = {};

  // Check database
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true, latency: Date.now() - dbStart };
  } catch (error) {
    checks.database = { ok: false, error: (error as Error).message };
  }

  // Check Omada controller
  const omadaStart = Date.now();
  try {
    const controllerOk = await omadaClient.healthCheck();
    checks.omadaController = { 
      ok: controllerOk, 
      latency: Date.now() - omadaStart,
      error: controllerOk ? undefined : 'Controller unreachable',
    };
  } catch (error) {
    checks.omadaController = { ok: false, error: (error as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  if (!allOk) {
    logger.warn({ checks }, 'Readiness check failed');
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'not ready',
    timestamp: new Date().toISOString(),
    checks,
  });
});
