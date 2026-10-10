import session, { SessionData } from 'express-session';
import { prisma } from './db';
import { logger } from './logger';

// =============================================================================
// Prisma-backed express-session store
// =============================================================================

const PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

type Callback<T = void> = (err?: unknown, value?: T) => void;

function settle<T>(promise: Promise<T>, callback?: Callback<T>): void {
  promise.then((value) => callback?.(null, value), (err) => callback?.(err));
}

function expiryOf(sess: SessionData): Date {
  const expires = sess.cookie?.expires;
  return expires ? new Date(expires) : new Date(Date.now() + FALLBACK_TTL_MS);
}

/**
 * Persists sessions in the HttpSession table so admin logins and in-progress
 * guest logins (CSRF tokens, portal params) survive container restarts.
 */
export class PrismaSessionStore extends session.Store {
  constructor() {
    super();
    setInterval(() => {
      prisma.httpSession.deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((err) => logger.warn({ err }, 'Failed to prune expired sessions'));
    }, PRUNE_INTERVAL_MS).unref();
  }

  get(sid: string, callback: Callback<SessionData | null>): void {
    settle(
      prisma.httpSession.findUnique({ where: { sid } }).then((row) =>
        row && row.expiresAt > new Date() ? (JSON.parse(row.data) as SessionData) : null),
      callback,
    );
  }

  set(sid: string, sess: SessionData, callback?: Callback): void {
    const data = JSON.stringify(sess);
    const expiresAt = expiryOf(sess);
    settle(
      prisma.httpSession.upsert({
        where: { sid },
        create: { sid, data, expiresAt },
        update: { data, expiresAt },
      }).then(() => undefined),
      callback,
    );
  }

  touch(sid: string, sess: SessionData, callback?: Callback): void {
    settle(
      prisma.httpSession.updateMany({ where: { sid }, data: { expiresAt: expiryOf(sess) } }).then(() => undefined),
      callback,
    );
  }

  destroy(sid: string, callback?: Callback): void {
    settle(prisma.httpSession.deleteMany({ where: { sid } }).then(() => undefined), callback);
  }
}
