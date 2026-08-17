import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import path from 'path';
import crypto from 'crypto';
import './types';

import { config } from './config';
import { logger } from './logger';
import { prisma } from './db';
import { omadaClient, OmadaConnectionError } from './services/omada-client';

import { portalRouter } from './routes/portal';
import { adminRouter } from './routes/admin';
import { healthRouter } from './routes/health';

// =============================================================================
// Application Setup
// =============================================================================

const app = express();

// Trust proxy if configured (for correct IP in rate limiting)
if (config.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// =============================================================================
// Security Middleware
// =============================================================================

// Helmet for security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Needed for Tailwind inline styles
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // May interfere with captive portal detection
}));

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
  max: config.RATE_LIMIT_MAX,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by IP + MAC (if available)
    const mac = req.body?.clientMac || req.session?.portalParams?.clientMac || '';
    return `${req.ip}-${mac}`;
  },
});

// =============================================================================
// Request Parsing
// =============================================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// =============================================================================
// Session Management
// =============================================================================

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.NODE_ENV === 'production' && config.TRUST_PROXY,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// =============================================================================
// CSRF Protection
// =============================================================================

// Simple CSRF protection using double-submit cookie pattern
// Note: csurf is deprecated, using custom implementation
app.use((req: Request, res: Response, next: NextFunction) => {
  // Generate CSRF token if not present
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  // Attach helper to request
  (req as any).csrfToken = () => req.session.csrfToken!;

  // Skip CSRF check for safe methods and health endpoints
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/health')) {
    return next();
  }

  // Validate CSRF token
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (token !== req.session.csrfToken) {
    logger.warn({ path: req.path, ip: req.ip }, 'CSRF token mismatch');
    return res.status(403).render('error', {
      title: 'Invalid Request',
      message: 'Your session has expired. Please refresh the page and try again.',
    });
  }

  next();
});

// =============================================================================
// Logging
// =============================================================================

app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
  },
}));

// =============================================================================
// View Engine
// =============================================================================

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// =============================================================================
// Routes
// =============================================================================

// Health checks (no rate limiting)
app.use('/', healthRouter);

// Portal routes (guest-facing)
app.use('/portal', loginLimiter, portalRouter);

// Root redirect to portal (for captive portal detection)
app.get('/', (req, res) => {
  // If there are portal redirect params, forward to portal
  if (req.query.clientMac) {
    const queryString = new URLSearchParams(req.query as Record<string, string>).toString();
    return res.redirect(`/portal?${queryString}`);
  }
  res.redirect('/portal');
});

// Admin routes
app.use('/admin', adminRouter);

// =============================================================================
// Error Handling
// =============================================================================

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).render('error', {
    title: 'Not Found',
    message: 'The page you requested could not be found.',
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, path: req.path }, 'Unhandled error');

  // Don't expose internal errors in production
  const message = config.NODE_ENV === 'development'
    ? err.message
    : 'An unexpected error occurred.';

  const statusCode = err instanceof OmadaConnectionError ? 503 : 500;

  res.status(statusCode).render('error', {
    title: 'Error',
    message,
    details: config.NODE_ENV === 'development' ? err.stack : undefined,
  });
});

// =============================================================================
// Startup
// =============================================================================

async function start() {
  logger.info('Starting Omada Guest Portal...');

  // Test database connection
  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (error) {
    logger.fatal({ error }, 'Failed to connect to database');
    process.exit(1);
  }

  // Initialize Omada client (non-blocking, will retry on first request if needed)
  try {
    await omadaClient.initialize();
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize Omada client - will retry on first request');
  }

  // Start server
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'Server listening');
    logger.info(`Portal: http://localhost:${config.PORT}/portal`);
    logger.info(`Admin:  http://localhost:${config.PORT}/admin`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

start().catch((error) => {
  logger.fatal({ error }, 'Failed to start server');
  process.exit(1);
});
