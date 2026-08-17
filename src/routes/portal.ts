import { Router, Request, Response, NextFunction, IRouter } from 'express';
import '../types';
import { prisma } from '../db';
import { logger } from '../logger';
import { config } from '../config';
import { omadaClient, OmadaConnectionError, OmadaAuthError } from '../services/omada-client';
import { portalRedirectSchema, guestLoginSchema } from '../utils/validation';
import { compareSync } from 'bcrypt';
import { ZodError } from 'zod';

// =============================================================================
// Portal Routes (Guest-Facing)
// =============================================================================

export const portalRouter: IRouter = Router();

/**
 * GET /portal
 * Landing page for guests - captures redirect parameters from the AP.
 */
portalRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Log what the AP actually sends (useful for debugging)
    logger.debug({ query: req.query }, 'Portal redirect received');

    // Validate and normalize redirect parameters
    const parseResult = portalRedirectSchema.safeParse(req.query);
    
    if (!parseResult.success) {
      logger.warn({ 
        errors: parseResult.error.issues,
        query: req.query 
      }, 'Invalid portal redirect parameters');
      
      return res.status(400).render('error', {
        title: 'Invalid Request',
        message: 'Missing or invalid network parameters. Please reconnect to the WiFi network.',
        details: config.NODE_ENV === 'development' ? parseResult.error.issues : undefined,
      });
    }

    const params = parseResult.data;

    // Store params in session for form submission
    req.session.portalParams = params;

    // Get portal settings
    const settings = await getOrCreateSettings();

    // Determine which auth methods are available
    const authMethods = {
      password: settings.sharedPasswordEnabled && !!settings.sharedPasswordHash,
      voucher: settings.voucherEnabled,
      clickThrough: settings.clickThroughEnabled,
    };

    // Render login page
    res.render('portal/login', {
      title: settings.welcomeHeading,
      settings,
      authMethods,
      params,
      csrfToken: req.csrfToken?.(),
      error: null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /portal/login
 * Process guest login and authorize with the controller.
 */
portalRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  let clientMac: string | undefined;

  try {
    // Get params from session (set during GET /portal)
    const portalParams = req.session.portalParams;
    if (!portalParams) {
      return res.status(400).render('error', {
        title: 'Session Expired',
        message: 'Your session has expired. Please reconnect to the WiFi network.',
      });
    }

    clientMac = portalParams.clientMac;

    // Validate form input
    const input = guestLoginSchema.parse({
      ...req.body,
      clientMac: portalParams.clientMac,
      apMac: portalParams.apMac,
      ssidName: portalParams.ssidName,
      radioId: portalParams.radioId,
      redirectUrl: portalParams.redirectUrl,
    });

    const settings = await getOrCreateSettings();

    // Check terms acceptance
    if (settings.termsRequired && !input.acceptTerms) {
      return renderLoginError(req, res, 'You must accept the terms of service.');
    }

    // Authenticate based on method
    let sessionDurationMinutes = config.DEFAULT_SESSION_DURATION_MINUTES;
    let voucherId: string | undefined;

    switch (input.authMethod) {
      case 'password':
        if (!settings.sharedPasswordHash) {
          return renderLoginError(req, res, 'Password authentication is not configured.');
        }
        if (!compareSync(input.password!, settings.sharedPasswordHash)) {
          await logAudit('GUEST_LOGIN_FAILED', false, {
            clientMac,
            ip: req.ip,
            method: 'password',
            reason: 'Invalid password',
          });
          return renderLoginError(req, res, 'Incorrect password.');
        }
        break;

      case 'voucher':
        const voucher = await validateVoucher(input.voucherCode!);
        if (!voucher.valid) {
          await logAudit('GUEST_LOGIN_FAILED', false, {
            clientMac,
            ip: req.ip,
            method: 'voucher',
            reason: voucher.error,
            code: input.voucherCode,
          });
          return renderLoginError(req, res, voucher.error!);
        }
        sessionDurationMinutes = voucher.voucher!.durationMinutes;
        voucherId = voucher.voucher!.id;
        break;

      case 'click-through':
        if (!settings.clickThroughEnabled) {
          return renderLoginError(req, res, 'Click-through authentication is not enabled.');
        }
        break;
    }

    // Authorize with Omada controller
    try {
      await omadaClient.authorizeClient({
        clientMac: input.clientMac,
        apMac: input.apMac,
        ssidName: input.ssidName,
        radioId: input.radioId,
        time: sessionDurationMinutes,
      });
    } catch (error) {
      if (error instanceof OmadaConnectionError) {
        logger.error({ error }, 'Cannot reach Omada controller');
        return res.status(503).render('error', {
          title: 'Service Unavailable',
          message: 'Unable to connect to the network controller. Please try again in a few moments.',
        });
      }
      if (error instanceof OmadaAuthError) {
        logger.error({ error }, 'Omada authorization failed');
        await logAudit('GUEST_LOGIN_FAILED', false, {
          clientMac,
          ip: req.ip,
          reason: error.message,
        });
        return renderLoginError(req, res, 'Authorization failed. Please try again.');
      }
      throw error;
    }

    // Create session record
    const session = await prisma.guestSession.create({
      data: {
        clientMac: input.clientMac,
        apMac: input.apMac,
        ssidName: input.ssidName,
        radioId: input.radioId,
        authMethod: input.authMethod === 'password' ? 'SHARED_PASSWORD' 
          : input.authMethod === 'voucher' ? 'VOUCHER' 
          : 'CLICK_THROUGH',
        voucherId,
        expiresAt: new Date(Date.now() + sessionDurationMinutes * 60 * 1000),
        redirectUrl: input.redirectUrl,
      },
    });

    // Update voucher usage if applicable
    if (voucherId) {
      await prisma.voucher.update({
        where: { id: voucherId },
        data: {
          usedCount: { increment: 1 },
          status: 'ACTIVE',
        },
      });
      await logAudit('VOUCHER_USED', true, { voucherId, clientMac });
    }

    // Log success
    await logAudit('GUEST_LOGIN_SUCCESS', true, {
      clientMac,
      ip: req.ip,
      method: input.authMethod,
      sessionId: session.id,
      durationMinutes: sessionDurationMinutes,
    });

    logger.info({
      clientMac,
      duration: Date.now() - startTime,
      sessionDurationMinutes,
    }, 'Guest authorized successfully');

    // Clear session params
    delete req.session.portalParams;

    // Render success page
    res.render('portal/success', {
      title: settings.successHeading,
      settings,
      redirectUrl: input.redirectUrl || 'https://www.google.com',
      expiresAt: session.expiresAt,
    });

  } catch (error) {
    if (error instanceof ZodError) {
      logger.warn({ errors: error.issues }, 'Validation error');
      return renderLoginError(req, res, 'Invalid input. Please try again.');
    }
    next(error);
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

async function getOrCreateSettings() {
  let settings = await prisma.portalSettings.findUnique({
    where: { id: 'default' },
  });

  if (!settings) {
    settings = await prisma.portalSettings.create({
      data: { id: 'default' },
    });
  }

  return settings;
}

async function validateVoucher(code: string): Promise<{
  valid: boolean;
  voucher?: { id: string; durationMinutes: number };
  error?: string;
}> {
  const voucher = await prisma.voucher.findUnique({
    where: { code: code.toUpperCase().trim() },
  });

  if (!voucher) {
    return { valid: false, error: 'Invalid voucher code.' };
  }

  if (voucher.status === 'REVOKED') {
    return { valid: false, error: 'This voucher has been revoked.' };
  }

  if (voucher.status === 'EXPIRED' || (voucher.expiresAt && voucher.expiresAt < new Date())) {
    return { valid: false, error: 'This voucher has expired.' };
  }

  if (voucher.usedCount >= voucher.maxUses) {
    return { valid: false, error: 'This voucher has reached its usage limit.' };
  }

  // Check max simultaneous devices
  const activeSessions = await prisma.guestSession.count({
    where: {
      voucherId: voucher.id,
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
    },
  });

  if (activeSessions >= voucher.maxDevices) {
    return { valid: false, error: 'Maximum devices for this voucher reached.' };
  }

  return { 
    valid: true, 
    voucher: { id: voucher.id, durationMinutes: voucher.durationMinutes } 
  };
}

async function renderLoginError(req: Request, res: Response, errorMessage: string) {
  const settings = await getOrCreateSettings();
  const params = req.session.portalParams;

  const authMethods = {
    password: settings.sharedPasswordEnabled && !!settings.sharedPasswordHash,
    voucher: settings.voucherEnabled,
    clickThrough: settings.clickThroughEnabled,
  };

  return res.status(400).render('portal/login', {
    title: settings.welcomeHeading,
    settings,
    authMethods,
    params,
    csrfToken: req.csrfToken?.(),
    error: errorMessage,
  });
}

async function logAudit(
  action: string,
  success: boolean,
  details: Record<string, unknown>
) {
  try {
    await prisma.auditLog.create({
      data: {
        action: action as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        success,
        details: JSON.stringify(details),
        ipAddress: details.ip as string | undefined,
        clientMac: details.clientMac as string | undefined,
        voucherId: details.voucherId as string | undefined,
        sessionId: details.sessionId as string | undefined,
      },
    });
  } catch (error) {
    logger.error({ error, action, details }, 'Failed to write audit log');
  }
}
