import { config } from '../config';
import { logger } from '../logger';
import { Agent, fetch } from 'undici';

// Create an agent that ignores self-signed certificates (common for Omada controllers)
const httpsAgent = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

// =============================================================================
// Omada Controller API Client
// =============================================================================

/**
 * Query parameters sent by the Omada AP when redirecting to the external portal.
 * These vary slightly between controller versions.
 */
export interface PortalRedirectParams {
  clientMac: string;
  apMac: string;
  ssidName: string;
  radioId: number;
  site?: string;        // Site name
  redirectUrl?: string; // Original URL the client was trying to reach
  // v5.x specific
  t?: string;           // Timestamp
  // Legacy v3/v4 may use different parameter names
}

/**
 * Authorization request to the Omada controller.
 */
export interface AuthorizeClientRequest {
  clientMac: string;
  apMac: string;
  ssidName: string;
  radioId: number;
  /** Duration in minutes */
  time: number;
  /** Auth type: 0 = portal, 1 = radius, etc. */
  authType?: number;
}

interface OmadaApiResponse<T = unknown> {
  errorCode: number;
  msg?: string;
  result?: T;
}

interface ControllerInfo {
  omadacId: string;
  controllerVer: string;
  apiVer: string;
  configured: boolean;
  type: number;
  supportApp: boolean;
}

interface LoginResult {
  token: string;
}

/**
 * Omada Controller API client.
 * Handles authentication and client authorization for the external portal flow.
 */
export class OmadaClient {
  private readonly baseUrl: string;
  private readonly siteName: string;
  private readonly operatorUsername: string;
  private readonly operatorPassword: string;

  private controllerId: string | null = null;
  private token: string | null = null;
  private csrfToken: string | null = null;
  private cookies: string[] = [];

  constructor(options?: {
    baseUrl?: string;
    siteName?: string;
    operatorUsername?: string;
    operatorPassword?: string;
  }) {
    this.baseUrl = options?.baseUrl ?? config.OMADA_CONTROLLER_URL;
    this.siteName = options?.siteName ?? config.OMADA_SITE_NAME;
    this.operatorUsername = options?.operatorUsername ?? config.OMADA_OPERATOR_USERNAME;
    this.operatorPassword = options?.operatorPassword ?? config.OMADA_OPERATOR_PASSWORD;
  }

  /**
   * Initialize the client by fetching controller info and logging in.
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Omada client...');
    await this.fetchControllerInfo();
    await this.login();
    logger.info({ controllerId: this.controllerId }, 'Omada client initialized');
  }

  /**
   * Get controller info including the controller ID.
   */
  async fetchControllerInfo(): Promise<ControllerInfo> {
    const response = await this.request<ControllerInfo>('GET', '/api/info');
    
    if (!response.result?.omadacId) {
      throw new Error('Failed to get controller ID from /api/info');
    }

    this.controllerId = response.result.omadacId;
    logger.info({
      controllerId: this.controllerId,
      version: response.result.controllerVer,
    }, 'Controller info retrieved');

    return response.result;
  }

  /**
   * Authenticate with the controller as a hotspot operator.
   */
  async login(): Promise<void> {
    if (!this.controllerId) {
      await this.fetchControllerInfo();
    }

    logger.debug('Logging in to Omada controller...');

    // Omada v5.x hotspot operator login endpoint
    // TODO: Verify this endpoint for v5.15 - documentation suggests it may be:
    // POST /{omadacId}/api/v2/hotspot/login
    // Body: { name: string, password: string }
    const endpoint = `/${this.controllerId}/api/v2/hotspot/login`;
    
    const response = await this.request<LoginResult>('POST', endpoint, {
      name: this.operatorUsername,
      password: this.operatorPassword,
    });

    if (response.errorCode !== 0) {
      throw new Error(`Login failed: ${response.msg || 'Unknown error'} (code: ${response.errorCode})`);
    }

    if (response.result?.token) {
      this.token = response.result.token;
    }

    logger.info('Successfully logged in to Omada controller');
  }

  /**
   * Authorize a client for internet access.
   */
  async authorizeClient(request: AuthorizeClientRequest): Promise<void> {
    if (!this.controllerId) {
      throw new Error('Client not initialized. Call initialize() first.');
    }

    // Ensure we're logged in
    if (!this.token && this.cookies.length === 0) {
      await this.login();
    }

    logger.info({ 
      clientMac: request.clientMac,
      ssid: request.ssidName,
      durationMinutes: request.time,
    }, 'Authorizing client');

    // TODO: Verify this endpoint for v5.15
    // POST /{omadacId}/api/v2/hotspot/extPortal/auth
    // Body varies by version. Documented fields:
    // - clientMac: string (MAC address of the client)
    // - apMac: string (MAC address of the AP)
    // - ssidName: string
    // - radioId: number (0 = 2.4GHz, 1 = 5GHz)
    // - time: number (duration in MINUTES for v5.x, was milliseconds in older versions)
    // - authType: number (0 for external portal auth)
    const endpoint = `/${this.controllerId}/api/v2/hotspot/extPortal/auth`;

    const body = {
      clientMac: request.clientMac,
      apMac: request.apMac,
      ssidName: request.ssidName,
      radioId: request.radioId,
      time: request.time, // Minutes in v5.x
      authType: request.authType ?? 0,
    };

    const response = await this.request('POST', endpoint, body);

    if (response.errorCode !== 0) {
      // Handle specific error codes
      // TODO: Document known error codes from testing
      const errorMessages: Record<number, string> = {
        '-1': 'General error',
        '-1001': 'Unauthorized - token expired',
        '-1002': 'Invalid parameters',
      };

      const message = errorMessages[response.errorCode] || response.msg || 'Unknown error';
      throw new OmadaAuthError(
        `Failed to authorize client: ${message}`,
        response.errorCode,
        request.clientMac
      );
    }

    logger.info({ clientMac: request.clientMac }, 'Client authorized successfully');
  }

  /**
   * Deauthorize (disconnect) a client.
   */
  async deauthorizeClient(clientMac: string): Promise<void> {
    if (!this.controllerId) {
      throw new Error('Client not initialized');
    }

    logger.info({ clientMac }, 'Deauthorizing client');

    // TODO: Verify this endpoint. Options may include:
    // POST /{omadacId}/api/v2/hotspot/extPortal/deauth
    // DELETE /{omadacId}/api/v2/hotspot/clients/{clientMac}
    // POST /{omadacId}/api/v2/sites/{siteId}/cmd/stamgr with action: 'kick-sta'
    const endpoint = `/${this.controllerId}/api/v2/hotspot/extPortal/deauth`;

    const response = await this.request('POST', endpoint, {
      clientMac,
    });

    if (response.errorCode !== 0) {
      throw new Error(`Failed to deauthorize client: ${response.msg}`);
    }
  }

  /**
   * Check if the controller is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchControllerInfo();
      return true;
    } catch (error) {
      logger.warn({ error }, 'Controller health check failed');
      return false;
    }
  }

  /**
   * Make an HTTP request to the Omada controller.
   */
  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<OmadaApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add auth headers
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.csrfToken) {
      headers['Csrf-Token'] = this.csrfToken;
    }
    if (this.cookies.length > 0) {
      headers['Cookie'] = this.cookies.join('; ');
    }

    logger.debug({ method, url }, 'Omada API request');

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        dispatcher: httpsAgent,
      });

      // Capture cookies and CSRF token from response
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        this.cookies = setCookie.split(',').map((c) => c.split(';')[0].trim());
        
        // Extract CSRF token if present
        const csrfCookie = this.cookies.find((c) => c.startsWith('CSRF-TOKEN='));
        if (csrfCookie) {
          this.csrfToken = csrfCookie.split('=')[1];
        }
      }

      const data = await response.json() as OmadaApiResponse<T>;

      // Handle 401 - re-authenticate
      if (response.status === 401 || data.errorCode === -1001) {
        logger.warn('Token expired, re-authenticating...');
        this.token = null;
        this.cookies = [];
        await this.login();
        // Retry the request
        return this.request(method, path, body);
      }

      return data;
    } catch (error) {
      // Handle network errors gracefully
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new OmadaConnectionError(
          `Cannot connect to Omada controller at ${this.baseUrl}`,
          error
        );
      }
      throw error;
    }
  }
}

// =============================================================================
// Custom Errors
// =============================================================================

export class OmadaConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'OmadaConnectionError';
  }
}

export class OmadaAuthError extends Error {
  constructor(
    message: string,
    public readonly errorCode: number,
    public readonly clientMac?: string
  ) {
    super(message);
    this.name = 'OmadaAuthError';
  }
}

// =============================================================================
// Singleton instance
// =============================================================================

export const omadaClient = new OmadaClient();
