// =============================================================================
// Type Declarations
// =============================================================================

import 'express-session';
import 'express';

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    adminId?: string;
    adminUsername?: string;
    portalParams?: {
      clientMac: string;
      apMac: string;
      ssidName: string;
      radioId: number;
      site?: string;
      redirectUrl?: string;
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      csrfToken?: () => string;
    }
  }
}

export {};
