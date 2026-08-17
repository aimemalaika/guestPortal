import { Router, Request, Response, NextFunction, IRouter } from 'express';
import '../types';
import { prisma } from '../db';
import { logger } from '../logger';
import { hashSync, compareSync } from 'bcrypt';
import { adminLoginSchema, adminSetupSchema, createVoucherSchema, portalSettingsSchema } from '../utils/validation';
import { randomBytes } from 'crypto';
import { ZodError } from 'zod';
import { omadaClient } from '../services/omada-client';

// =============================================================================
// Admin Routes
// =============================================================================

export const adminRouter: IRouter = Router();

// Middleware to check if setup is complete
adminRouter.use(async (req: Request, res: Response, next: NextFunction) => {
  const adminCount = await prisma.adminUser.count();
  const isSetupRoute = req.path === '/setup' || req.path === '/setup/complete';
  
  if (adminCount === 0 && !isSetupRoute) {
    return res.redirect('/admin/setup');
  }
  
  if (adminCount > 0 && isSetupRoute) {
    return res.redirect('/admin/login');
  }
  
  next();
});

// =============================================================================
// Setup (First Run)
// =============================================================================

adminRouter.get('/setup', (req: Request, res: Response) => {
  res.render('admin/setup', {
    title: 'Initial Setup',
    csrfToken: req.csrfToken?.(),
    error: null,
  });
});

adminRouter.post('/setup/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Double-check no admin exists
    const adminCount = await prisma.adminUser.count();
    if (adminCount > 0) {
      return res.redirect('/admin/login');
    }

    const input = adminSetupSchema.parse(req.body);

    // Create admin user
    await prisma.adminUser.create({
      data: {
        username: input.username,
        passwordHash: hashSync(input.password, 12),
      },
    });

    await logAdminAudit('ADMIN_CREATED', true, { username: input.username }, req);

    logger.info({ username: input.username }, 'Initial admin created');

    res.redirect('/admin/login?setup=complete');
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).render('admin/setup', {
        title: 'Initial Setup',
        csrfToken: req.csrfToken?.(),
        error: error.issues[0]?.message || 'Invalid input',
      });
    }
    next(error);
  }
});

// =============================================================================
// Authentication
// =============================================================================

adminRouter.get('/login', (req: Request, res: Response) => {
  res.render('admin/login', {
    title: 'Admin Login',
    csrfToken: req.csrfToken?.(),
    error: null,
    success: req.query.setup === 'complete' ? 'Setup complete. Please log in.' : null,
  });
});

adminRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = adminLoginSchema.parse(req.body);

    const admin = await prisma.adminUser.findUnique({
      where: { username: input.username },
    });

    if (!admin || !compareSync(input.password, admin.passwordHash)) {
      await logAdminAudit('ADMIN_LOGIN', false, { username: input.username }, req);
      return res.status(401).render('admin/login', {
        title: 'Admin Login',
        csrfToken: req.csrfToken?.(),
        error: 'Invalid username or password',
        success: null,
      });
    }

    // Update last login
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    // Set session
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;

    await logAdminAudit('ADMIN_LOGIN', true, { username: input.username, adminId: admin.id }, req);

    res.redirect('/admin/dashboard');
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).render('admin/login', {
        title: 'Admin Login',
        csrfToken: req.csrfToken?.(),
        error: 'Invalid input',
        success: null,
      });
    }
    next(error);
  }
});

adminRouter.post('/logout', (req: Request, res: Response) => {
  const adminId = req.session.adminId;
  req.session.destroy(() => {
    if (adminId) {
      logAdminAudit('ADMIN_LOGOUT', true, { adminId }, req);
    }
    res.redirect('/admin/login');
  });
});

// =============================================================================
// Auth Middleware for Protected Routes
// =============================================================================

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.adminId) {
    return res.redirect('/admin/login');
  }
  next();
}

// Apply auth middleware to all routes below
adminRouter.use(requireAuth);

// =============================================================================
// Dashboard
// =============================================================================

adminRouter.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [
      activeSessions,
      totalVouchers,
      unusedVouchers,
      recentActivity,
    ] = await Promise.all([
      prisma.guestSession.count({
        where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
      }),
      prisma.voucher.count(),
      prisma.voucher.count({ where: { status: 'UNUSED' } }),
      prisma.auditLog.findMany({
        take: 10,
        orderBy: { timestamp: 'desc' },
      }),
    ]);

    // Check controller connectivity
    const controllerOnline = await omadaClient.healthCheck();

    res.render('admin/dashboard', {
      title: 'Dashboard',
      admin: { username: req.session.adminUsername },
      stats: { activeSessions, totalVouchers, unusedVouchers },
      recentActivity,
      controllerOnline,
      csrfToken: req.csrfToken?.(),
    });
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// Voucher Management
// =============================================================================

adminRouter.get('/vouchers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const where: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (status && status !== 'all') {
      where.status = status.toUpperCase();
    }
    if (search) {
      where.code = { contains: search.toUpperCase() };
    }

    const vouchers = await prisma.voucher.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.render('admin/vouchers', {
      title: 'Voucher Management',
      admin: { username: req.session.adminUsername },
      vouchers,
      filters: { status, search },
      csrfToken: req.csrfToken?.(),
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/vouchers/create', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = createVoucherSchema.parse(req.body);

    const batchId = randomBytes(8).toString('hex');
    const vouchers: { code: string }[] = [];

    for (let i = 0; i < input.quantity; i++) {
      const code = generateVoucherCode();
      vouchers.push({ code });

      await prisma.voucher.create({
        data: {
          code,
          durationMinutes: input.durationMinutes,
          dataLimitMb: input.dataLimitMb,
          maxDevices: input.maxDevices,
          maxUses: input.maxUses,
          expiresAt: input.expiresAt,
          note: input.note,
          batchId,
        },
      });
    }

    await logAdminAudit('VOUCHER_BATCH_CREATED', true, {
      batchId,
      quantity: input.quantity,
      durationMinutes: input.durationMinutes,
      adminId: req.session.adminId,
    }, req);

    logger.info({ batchId, quantity: input.quantity }, 'Voucher batch created');

    // If single voucher, redirect to list
    // If batch, redirect to print view
    if (input.quantity === 1) {
      res.redirect('/admin/vouchers');
    } else {
      res.redirect(`/admin/vouchers/print?batch=${batchId}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).redirect('/admin/vouchers?error=invalid');
    }
    next(error);
  }
});

adminRouter.get('/vouchers/print', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batchId = req.query.batch as string;
    if (!batchId) {
      return res.redirect('/admin/vouchers');
    }

    const vouchers = await prisma.voucher.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
    });

    const settings = await prisma.portalSettings.findUnique({
      where: { id: 'default' },
    });

    res.render('admin/vouchers-print', {
      title: 'Print Vouchers',
      vouchers,
      settings,
      ssid: process.env.GUEST_SSID || 'Guest WiFi',
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/vouchers/:id/revoke', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const voucher = await prisma.voucher.update({
      where: { id },
      data: { status: 'REVOKED' },
    });

    // Revoke any active sessions using this voucher
    const activeSessions = await prisma.guestSession.findMany({
      where: { voucherId: id, status: 'ACTIVE' },
    });

    for (const session of activeSessions) {
      try {
        await omadaClient.deauthorizeClient(session.clientMac);
      } catch (error) {
        logger.warn({ error, clientMac: session.clientMac }, 'Failed to deauthorize client');
      }

      await prisma.guestSession.update({
        where: { id: session.id },
        data: { status: 'REVOKED', endedAt: new Date() },
      });
    }

    await logAdminAudit('VOUCHER_REVOKED', true, {
      voucherId: id,
      code: voucher.code,
      sessionsRevoked: activeSessions.length,
      adminId: req.session.adminId,
    }, req);

    res.redirect('/admin/vouchers');
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// Session Management
// =============================================================================

adminRouter.get('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await prisma.guestSession.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
      include: { voucher: true },
      orderBy: { startedAt: 'desc' },
    });

    res.render('admin/sessions', {
      title: 'Active Sessions',
      admin: { username: req.session.adminUsername },
      sessions,
      csrfToken: req.csrfToken?.(),
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/sessions/:id/disconnect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const session = await prisma.guestSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).redirect('/admin/sessions');
    }

    // Deauthorize with controller
    try {
      await omadaClient.deauthorizeClient(session.clientMac);
    } catch (error) {
      logger.warn({ error, clientMac: session.clientMac }, 'Failed to deauthorize client');
    }

    await prisma.guestSession.update({
      where: { id },
      data: { status: 'DISCONNECTED', endedAt: new Date() },
    });

    await logAdminAudit('SESSION_TERMINATED', true, {
      sessionId: id,
      clientMac: session.clientMac,
      adminId: req.session.adminId,
    }, req);

    res.redirect('/admin/sessions');
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/sessions/:id/extend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const minutes = parseInt(req.body.minutes) || 60;

    const session = await prisma.guestSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).redirect('/admin/sessions');
    }

    // Re-authorize with extended time
    await omadaClient.authorizeClient({
      clientMac: session.clientMac,
      apMac: session.apMac,
      ssidName: session.ssidName,
      radioId: session.radioId,
      time: minutes,
    });

    await prisma.guestSession.update({
      where: { id },
      data: { 
        expiresAt: new Date(Date.now() + minutes * 60 * 1000),
      },
    });

    await logAdminAudit('SESSION_EXTENDED', true, {
      sessionId: id,
      clientMac: session.clientMac,
      minutes,
      adminId: req.session.adminId,
    }, req);

    res.redirect('/admin/sessions');
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// Settings / Branding
// =============================================================================

adminRouter.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let settings = await prisma.portalSettings.findUnique({
      where: { id: 'default' },
    });

    if (!settings) {
      settings = await prisma.portalSettings.create({
        data: { id: 'default' },
      });
    }

    res.render('admin/settings', {
      title: 'Portal Settings',
      admin: { username: req.session.adminUsername },
      settings,
      csrfToken: req.csrfToken?.(),
      success: req.query.saved === 'true',
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = portalSettingsSchema.parse(req.body);

    const updateData: any = { ...input }; // eslint-disable-line @typescript-eslint/no-explicit-any

    // Hash shared password if provided
    if (input.sharedPassword) {
      updateData.sharedPasswordHash = hashSync(input.sharedPassword, 12);
    }
    delete updateData.sharedPassword;

    await prisma.portalSettings.update({
      where: { id: 'default' },
      data: updateData,
    });

    await logAdminAudit('SETTINGS_UPDATED', true, {
      adminId: req.session.adminId,
      fields: Object.keys(input),
    }, req);

    res.redirect('/admin/settings?saved=true');
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).redirect('/admin/settings?error=invalid');
    }
    next(error);
  }
});

// =============================================================================
// Audit Log
// =============================================================================

adminRouter.get('/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const action = req.query.action as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = 50;

    const where: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (action && action !== 'all') {
      where.action = action;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          admin: { select: { username: true } },
          voucher: { select: { code: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.render('admin/audit', {
      title: 'Audit Log',
      admin: { username: req.session.adminUsername },
      logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      filters: { action },
      csrfToken: req.csrfToken?.(),
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get('/audit/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      include: {
        admin: { select: { username: true } },
      },
    });

    // Generate CSV
    const headers = ['Timestamp', 'Action', 'Success', 'IP Address', 'Client MAC', 'Admin', 'Details'];
    const rows = logs.map((log) => [
      log.timestamp.toISOString(),
      log.action,
      log.success ? 'Yes' : 'No',
      log.ipAddress || '',
      log.clientMac || '',
      log.admin?.username || '',
      log.details || '',
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

function generateVoucherCode(): string {
  // Generate 8-character alphanumeric code (easy to type)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous: I,1,O,0
  let code = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

async function logAdminAudit(
  action: string,
  success: boolean,
  details: Record<string, unknown>,
  req: Request
) {
  try {
    await prisma.auditLog.create({
      data: {
        action: action as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        success,
        details: JSON.stringify(details),
        ipAddress: req.ip,
        adminId: details.adminId as string | undefined,
        voucherId: details.voucherId as string | undefined,
        sessionId: details.sessionId as string | undefined,
      },
    });
  } catch (error) {
    logger.error({ error, action, details }, 'Failed to write audit log');
  }
}
