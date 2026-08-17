import { z } from 'zod';

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * MAC address regex - accepts common formats:
 * - AA:BB:CC:DD:EE:FF
 * - AA-BB-CC-DD-EE-FF
 * - AABBCCDDEEFF
 */
const MAC_REGEX = /^([0-9A-Fa-f]{2}[:-]?){5}[0-9A-Fa-f]{2}$/;

/**
 * Normalize MAC address to uppercase colon-separated format.
 */
export function normalizeMac(mac: string): string {
  // Remove all separators
  const clean = mac.replace(/[:-]/g, '').toUpperCase();
  
  if (clean.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}`);
  }
  
  // Format as AA:BB:CC:DD:EE:FF
  return clean.match(/.{2}/g)!.join(':');
}

/**
 * Validate MAC address format.
 */
export function isValidMac(mac: string): boolean {
  return MAC_REGEX.test(mac);
}

/**
 * Zod schema for MAC address with normalization.
 */
export const macAddressSchema = z
  .string()
  .refine(isValidMac, { message: 'Invalid MAC address format' })
  .transform(normalizeMac);

/**
 * Schema for portal redirect parameters from Omada AP.
 * These come from the network and MUST NOT be trusted.
 */
export const portalRedirectSchema = z.object({
  clientMac: macAddressSchema,
  apMac: macAddressSchema,
  ssidName: z.string().min(1).max(32),
  radioId: z.coerce.number().int().min(0).max(2),
  site: z.string().optional(),
  redirectUrl: z.string().url().optional().or(z.literal('')),
  // Legacy parameter names (v3/v4)
  ap: macAddressSchema.optional(), // Alternative to apMac
  ssid: z.string().optional(),     // Alternative to ssidName
  t: z.string().optional(),        // Timestamp
}).transform((data) => ({
  clientMac: data.clientMac,
  apMac: data.apMac || data.ap!,
  ssidName: data.ssidName || data.ssid!,
  radioId: data.radioId,
  site: data.site,
  redirectUrl: data.redirectUrl || undefined,
}));

export type PortalRedirectParams = z.infer<typeof portalRedirectSchema>;

/**
 * Schema for guest login form.
 */
export const guestLoginSchema = z.object({
  authMethod: z.enum(['password', 'voucher', 'click-through']),
  password: z.string().optional(),
  voucherCode: z.string().optional(),
  acceptTerms: z.coerce.boolean(),
  // Hidden fields from redirect
  clientMac: macAddressSchema,
  apMac: macAddressSchema,
  ssidName: z.string(),
  radioId: z.coerce.number(),
  redirectUrl: z.string().optional(),
}).refine(
  (data) => {
    if (data.authMethod === 'password') return !!data.password;
    if (data.authMethod === 'voucher') return !!data.voucherCode;
    return true;
  },
  { message: 'Credential required for selected auth method' }
);

export type GuestLoginInput = z.infer<typeof guestLoginSchema>;

/**
 * Schema for voucher creation.
 */
export const createVoucherSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(1000).default(1),
  durationMinutes: z.coerce.number().int().min(1).max(525600), // Up to 1 year
  dataLimitMb: z.coerce.number().int().min(0).optional(),
  maxDevices: z.coerce.number().int().min(1).max(10).default(1),
  maxUses: z.coerce.number().int().min(1).max(1000).default(1),
  expiresAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
});

export type CreateVoucherInput = z.infer<typeof createVoucherSchema>;

/**
 * Schema for admin login.
 */
export const adminLoginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1),
});

/**
 * Schema for admin creation (first-run setup).
 */
export const adminSetupSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'Username can only contain letters, numbers, underscores, and hyphens',
  }),
  password: z.string().min(12, { message: 'Password must be at least 12 characters' }),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

/**
 * Schema for portal settings update.
 */
export const portalSettingsSchema = z.object({
  welcomeHeading: z.string().max(100).optional(),
  welcomeBody: z.string().max(1000).optional(),
  termsText: z.string().max(5000).optional(),
  termsRequired: z.coerce.boolean().optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  sharedPasswordEnabled: z.coerce.boolean().optional(),
  sharedPassword: z.string().optional(),
  voucherEnabled: z.coerce.boolean().optional(),
  clickThroughEnabled: z.coerce.boolean().optional(),
  successHeading: z.string().max(100).optional(),
  successBody: z.string().max(1000).optional(),
  redirectDelay: z.coerce.number().int().min(0).max(30).optional(),
});
