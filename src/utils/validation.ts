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
  t: z.string().optional(),        // Timestamp
}).transform((data) => ({
  clientMac: data.clientMac,
  apMac: data.apMac,
  ssidName: data.ssidName,
  radioId: data.radioId,
  site: data.site,
  t: data.t,
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
  site: z.string().optional(),
  t: z.string().optional(),
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
const optionalNumber = (defaultValue?: number) =>
  z.preprocess((value) => {
    if (value === '' || value === null || value === undefined) {
      return defaultValue;
    }
    return Number(value);
  }, z.number().int().min(0).optional());

const optionalDate = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}, z.date().optional());

const voucherCodeSchema = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  return String(value).trim().toUpperCase();
}, z.string().min(4).max(32).regex(/^[A-Z0-9_-]+$/, {
  message: 'Voucher code can only contain letters, numbers, hyphens, and underscores',
}).optional());

export const createVoucherSchema = z.object({
  quantity: z.coerce.number().int().min(1).max(1000).default(1),
  durationMinutes: z.coerce.number().int().min(1).max(525600), // Up to 1 year
  dataLimitMb: optionalNumber(),
  maxDevices: z.coerce.number().int().min(1).max(10).default(1),
  maxUses: z.coerce.number().int().min(1).max(1000).default(1),
  expiresAt: optionalDate,
  customCode: voucherCodeSchema,
  note: z.preprocess((value) => (value === '' ? undefined : value), z.string().max(500).optional()),
}).refine((data) => data.quantity === 1 || !data.customCode, {
  message: 'Custom voucher codes can only be used when creating a single voucher',
  path: ['customCode'],
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
const newPasswordFields = {
  password: z.string().min(12, { message: 'Password must be at least 12 characters' }),
  confirmPassword: z.string(),
};

const passwordsMatch = (data: { password: string; confirmPassword: string }) =>
  data.password === data.confirmPassword;
const passwordsMatchError = { message: 'Passwords do not match', path: ['confirmPassword'] };

export const adminSetupSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_-]+$/, {
    message: 'Username can only contain letters, numbers, underscores, and hyphens',
  }),
  ...newPasswordFields,
}).refine(passwordsMatch, passwordsMatchError);

/**
 * Schema for an admin changing their own password.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: 'Enter your current password' }),
  ...newPasswordFields,
}).refine(passwordsMatch, passwordsMatchError);

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
  // Empty clears the setting; must be reachable from the internet, not the portal's LAN address.
  successRedirectUrl: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().trim().url().regex(/^https?:\/\//i, { message: 'Must be an http(s) URL' }).nullable().optional(),
  ),
});
