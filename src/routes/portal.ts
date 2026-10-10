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
    // Prefer params from session; fallback to hidden form fields for captive browsers
    // that do not persist cookies/session reliably between GET and POST.
    let portalParams = req.session.portalParams;
    if (!portalParams) {
      const bodyParams = portalRedirectSchema.safeParse(req.body);
      if (!bodyParams.success) {
        return res.status(400).render('error', {
          title: 'Session Expired',
          message: 'Your session has expired. Please reconnect to the WiFi network.',
        });
      }
      portalParams = bodyParams.data;
      req.session.portalParams = portalParams;
    }

    clientMac = portalParams.clientMac;

    // Validate form input
    const input = guestLoginSchema.parse({
      ...req.body,
      clientMac: portalParams.clientMac,
      apMac: portalParams.apMac,
      ssidName: portalParams.ssidName,
      radioId: portalParams.radioId,
      site: portalParams.site,
      t: portalParams.t,
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
        site: input.site,
        // extPortal/auth expects duration in milliseconds.
        time: sessionDurationMinutes * 60 * 1000,
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
        logger.error({
          clientMac,
          errorCode: error.errorCode,
          errorMessage: error.message,
        }, 'Omada authorization failed');
        await logAudit('GUEST_LOGIN_FAILED', false, {
          clientMac,
          ip: req.ip,
          reason: error.message,
        });
        return renderLoginError(
          req,
          res,
          'We could not connect your device to the internet just now. Please try again in a moment.',
          502,
        );
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

    const shouldAutoRedirect = !!input.redirectUrl && !isCaptiveProbeUrl(input.redirectUrl);

    logger.info({
      clientMac,
      duration: Date.now() - startTime,
      sessionDurationMinutes,
      redirectUrl: input.redirectUrl,
      shouldAutoRedirect,
    }, 'Guest authorized successfully');

    // Clear session params
    delete req.session.portalParams;

    // Use a dedicated GET endpoint for success so captive mini-browsers reliably
    // display the page after POST completion.
    return res.redirect(303, `/portal/success?sid=${encodeURIComponent(session.id)}`);

  } catch (error) {
    if (error instanceof ZodError) {
      logger.warn({ errors: error.issues }, 'Validation error');
      return renderLoginError(req, res, 'Invalid input. Please try again.');
    }
    next(error);
  }
});

/**
 * GET /portal/success
 * Render success page by looking up the newly created session.
 */
portalRouter.get('/success', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sid = String(req.query.sid || '').trim();
    if (!sid) {
      return res.status(400).render('error', {
        title: 'Invalid Request',
        message: 'Missing session reference. Please reconnect to the WiFi network.',
      });
    }

    const session = await prisma.guestSession.findUnique({ where: { id: sid } });
    if (!session) {
      return res.status(404).render('error', {
        title: 'Session Not Found',
        message: 'Session not found. Please reconnect to the WiFi network.',
      });
    }

    const settings = await getOrCreateSettings();
    const shouldAutoRedirect = !!session.redirectUrl && !isCaptiveProbeUrl(session.redirectUrl);

    return res.render('portal/success', {
      title: settings.successHeading,
      settings,
      redirectUrl: shouldAutoRedirect ? session.redirectUrl : undefined,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
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

async function renderLoginError(req: Request, res: Response, errorMessage: string, status = 400) {
  const settings = await getOrCreateSettings();
  const sessionParams = req.session.portalParams;
  const bodyParams = portalRedirectSchema.safeParse(req.body);
  const params = sessionParams || (bodyParams.success ? bodyParams.data : undefined);

  const authMethods = {
    password: settings.sharedPasswordEnabled && !!settings.sharedPasswordHash,
    voucher: settings.voucherEnabled,
    clickThrough: settings.clickThroughEnabled,
  };

  return res.status(status).render('portal/login', {
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

function isCaptiveProbeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    // Common captive-portal probe URLs that should not be used for success-page redirect.
    return (
      (host.includes('gstatic.com') && path.includes('generate_204')) ||
      (host.includes('google.com') && path.includes('gen_204')) ||
      host.includes('msftconnecttest.com') ||
      host.includes('msftncsi.com') ||
      host.includes('captive.apple.com') ||
      host.includes('connectivitycheck.android.com') ||
      host.includes('detectportal.firefox.com')
    );
  } catch {
    return false;
  }
}
