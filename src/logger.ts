import pino from 'pino';
import { config } from './config';

// =============================================================================
// Structured Logger
// =============================================================================

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'token',
      'csrfToken',
      '*.password',
      '*.passwordHash',
      '*.token',
    ],
    remove: true,
  },
});

export type Logger = typeof logger;
