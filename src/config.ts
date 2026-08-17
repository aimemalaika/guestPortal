import 'dotenv/config';
import { z } from 'zod';

// =============================================================================
// Environment Configuration
// =============================================================================

const envSchema = z.object({
  // Server
  PORT: z.string().default('8080').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  TRUST_PROXY: z.string().default('0').transform((v) => v === '1' || v === 'true'),

  // Omada Controller
  OMADA_CONTROLLER_URL: z.string().url(),
  OMADA_SITE_NAME: z.string().min(1),
  OMADA_OPERATOR_USERNAME: z.string().min(1),
  OMADA_OPERATOR_PASSWORD: z.string().min(1),

  // Portal behaviour
  DEFAULT_SESSION_DURATION_MINUTES: z.string().default('60').transform(Number),
  GUEST_SSID: z.string().min(1),
  TZ: z.string().default('UTC'),

  // Database
  DATABASE_URL: z.string().default('file:./dev.db'),

  // Rate limiting
  RATE_LIMIT_MAX: z.string().default('10').transform(Number),
  RATE_LIMIT_WINDOW_MINUTES: z.string().default('15').transform(Number),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;
