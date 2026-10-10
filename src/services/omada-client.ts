import { config } from '../config';
import { logger } from '../logger';

// Node 20 exposes fetch globally, and this avoids the Undici runtime crash seen in the
// Alpine production image when fetching a self-signed Omada controller certificate.
if (config.OMADA_CONTROLLER_URL.startsWith('https://') || config.OMADA_CONTROLLER_URL.includes(':8043')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// =============================================================================
// Omada Controller API Client
// =============================================================================

/**
 * Authorization request to the Omada controller.
 */
export interface AuthorizeClientRequest {
  clientMac: string;
  apMac: string;
  ssidName: string;
  radioId: number;
  site?: string;        // Site from the portal redirect; defaults to OMADA_SITE_NAME
  /** Duration in milliseconds */
  time: number;
}

/** Hotspot session cookie issued by the v5.15 hotspot login endpoint. */
const SESSION_COOKIE = 'TPOMADA_SESSIONID';

/** extPortal/auth authType for external portal servers. */
const EXTERNAL_PORTAL_AUTH_TYPE = 4;

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

interface SiteInfo {
  id: string;
  name?: string;
}

interface LoginResult {
  token: string;
}

/**
 * Omada Controller API client.
 * Handles authentication and client authorization for the external portal flow.
 */
export function normalizeOmadaBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);

    if (url.protocol === 'http:' && (url.port === '8088' || !url.port)) {
      url.protocol = 'https:';
      url.port = '8043';
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    if (url.protocol === 'https:' && url.port === '8043') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return baseUrl.replace(/\/$/, '');
  }
}

export class OmadaClient {
  private baseUrl: string;
  private readonly siteName: string;
  private readonly operatorUsername: string;
  private readonly operatorPassword: string;

  private controllerId: string | null = null;
  private openApiToken: string | null = null;
  private csrfToken: string | null = null;
  private sessionId: string | null = null;
  private loginInFlight: Promise<void> | null = null;
  private openApiClientId: string = '';
  private openApiClientSecret: string = '';

  constructor(options?: {
    baseUrl?: string;
    siteName?: string;
    operatorUsername?: string;
    operatorPassword?: string;
    openApiClientId?: string;
    openApiClientSecret?: string;
  }) {
    this.baseUrl = normalizeOmadaBaseUrl(options?.baseUrl ?? config.OMADA_CONTROLLER_URL);
    this.siteName = options?.siteName ?? config.OMADA_SITE_NAME;
    this.operatorUsername = options?.operatorUsername ?? config.OMADA_OPERATOR_USERNAME;
    this.operatorPassword = options?.operatorPassword ?? config.OMADA_OPERATOR_PASSWORD;
    this.openApiClientId = options?.openApiClientId ?? process.env.OMADA_OPENAPI_CLIENT_ID ?? '';
    this.openApiClientSecret = options?.openApiClientSecret ?? process.env.OMADA_OPENAPI_CLIENT_SECRET ?? '';
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OmadaConnectionError(`Request to Omada controller timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
   * Single-flight: concurrent callers share one in-progress login.
   */
  login(): Promise<void> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.performLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async performLogin(): Promise<void> {
    if (!this.controllerId) {
      await this.fetchControllerInfo();
    }

    logger.debug('Logging in to Omada controller as hotspot operator...');

    this.csrfToken = null;
    this.sessionId = null;

    // POST /{omadacId}/api/v2/hotspot/login sets TPOMADA_SESSIONID and returns the CSRF token in result.token.
    const response = await this.request<LoginResult>('POST', `/${this.controllerId}/api/v2/hotspot/login`, {
      name: this.operatorUsername,
      password: this.operatorPassword,
    }, true);

    if (response.errorCode !== 0) {
      throw new OmadaAuthError(
        `Login failed: ${response.msg || 'Unknown error'} (code: ${response.errorCode})`,
        response.errorCode,
      );
    }

    if (!response.result?.token || !this.sessionId) {
      throw new OmadaAuthError(`Login failed: missing CSRF token or ${SESSION_COOKIE} cookie`, -1);
    }

    this.csrfToken = response.result.token;
    logger.info('Successfully logged in as hotspot operator');
  }

  /**
   * Obtain OpenAPI access token for guest client authorization.
   * Uses client credentials grant type to get an API token.
   */
  private async getOpenApiToken(): Promise<string> {
    if (this.openApiToken) {
      return this.openApiToken;
    }

    if (!this.openApiClientId || !this.openApiClientSecret) {
      throw new Error('OpenAPI credentials not configured. Set OMADA_OPENAPI_CLIENT_ID and OMADA_OPENAPI_CLIENT_SECRET.');
    }

    if (!this.controllerId) {
      throw new Error('Controller ID not available. Call fetchControllerInfo() first.');
    }

    logger.debug('Obtaining OpenAPI token using client credentials...');

    // OpenAPI token endpoint: POST /openapi/authorize/token?grant_type=client_credentials
    // Body: { omadacId, client_id, client_secret }
    const url = `${this.baseUrl}/openapi/authorize/token?grant_type=client_credentials`;
    
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        omadacId: this.controllerId,
        client_id: this.openApiClientId,
        client_secret: this.openApiClientSecret,
      }),
    });

    let data: OmadaApiResponse<{ accessToken: string }>;;
    try {
      data = (await response.json()) as OmadaApiResponse<{ accessToken: string }>;
    } catch {
      throw new Error(`Failed to parse OpenAPI token response: HTTP ${response.status}`);
    }

    if (data.errorCode !== 0 || !data.result?.accessToken) {
      throw new OmadaAuthError(
        `Failed to get OpenAPI token: ${data.msg || 'Unknown error'}`,
        data.errorCode,
      );
    }

    this.openApiToken = data.result.accessToken;
    logger.debug('Successfully obtained OpenAPI token');
    return this.openApiToken;
  }

  /**
   * Authorize a client for internet access via the hotspot extPortal/auth endpoint.
   */
  async authorizeClient(request: AuthorizeClientRequest): Promise<void> {
    if (!this.csrfToken) {
      await this.login();
    }

    const site = request.site || this.siteName;

    logger.info({
      clientMac: request.clientMac,
      site,
      ssid: request.ssidName,
      durationMs: request.time,
    }, 'Authorizing client');

    // The controller stores MACs verbatim and the AP only matches its own AA-BB-CC-DD-EE-FF form.
    const data = await this.request('POST', `/${this.controllerId}/api/v2/hotspot/extPortal/auth`, {
      clientMac: this.formatOmadaMac(request.clientMac),
      apMac: this.formatOmadaMac(request.apMac),
      ssidName: request.ssidName,
      radioId: request.radioId,
      site,
      time: request.time,
      authType: EXTERNAL_PORTAL_AUTH_TYPE,
    });

    if (data.errorCode !== 0) {
      const errorMessages: Record<number, string> = {
        '-41009': 'Failed to authorize this client',
        '-41010': 'This client does not exist on this site',
        '-42003': 'Hotspot operator does not exist',
        '-42006': 'Failed to log in',
      };

      const message = errorMessages[data.errorCode] || data.msg || 'Unknown error';
      throw new OmadaAuthError(
        `Failed to authorize client: ${message}`,
        data.errorCode,
        request.clientMac
      );
    }

    logger.info({ clientMac: request.clientMac, site }, 'Client authorized successfully');
  }

  /**
   * Deauthorize (disconnect) a client.
   */
  async deauthorizeClient(clientMac: string): Promise<void> {
    if (!this.controllerId) {
      throw new Error('Client not initialized');
    }

    logger.info({ clientMac }, 'Deauthorizing client');

    // Preferred and authoritative flow (OpenAPI v1):
    // resolve auth record id by MAC, then disconnect by record id.
    const siteId = await this.resolveSiteId(this.siteName);
    const authRecordId = await this.findAuthedRecordId(siteId, clientMac);

    if (!authRecordId) {
      throw new OmadaAuthError(
        'Failed to disconnect client: no matching active auth record found',
        -41018,
        clientMac,
      );
    }

    await this.disconnectAuthedRecord(siteId, authRecordId);
    logger.info({ clientMac, siteId, authRecordId }, 'Client disconnected via OpenAPI authed-record endpoint');
  }

  /**
   * Disconnect an authenticated client record via OpenAPI.
   * POST /openapi/v1/{omadacId}/sites/{siteId}/hotspot/authed-records/{id}/disconnect
   */
  private async disconnectAuthedRecord(siteId: string, authRecordId: string): Promise<void> {
    if (!this.controllerId) {
      throw new Error('Client not initialized');
    }

    const accessToken = await this.getOpenApiToken();
    const endpoint = `/openapi/v1/${this.controllerId}/sites/${siteId}/hotspot/authed-records/${authRecordId}/disconnect`;

    const response = await this.fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `AccessToken=${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: '',
    });

    const data = await this.parseOpenApiResponse(response);
    if (data.errorCode !== 0) {
      throw new OmadaAuthError(
        `Failed to disconnect authed client: ${data.msg || 'Unknown error'}`,
        data.errorCode,
      );
    }
  }

  /**
   * Resolve site identifier for OpenAPI endpoints.
   * Accepts either a site ID or a site name.
   */
  private async resolveSiteId(siteOrId?: string): Promise<string> {
    const candidate = (siteOrId || this.siteName || '').trim();
    if (!candidate) {
      throw new Error('Site name or site ID is required to disconnect a client');
    }

    // Omada site IDs are typically 32-char hex strings.
    if (/^[a-f0-9]{32}$/i.test(candidate)) {
      return candidate;
    }

    if (!this.controllerId) {
      throw new Error('Controller ID not available. Call fetchControllerInfo() first.');
    }

    const accessToken = await this.getOpenApiToken();
    const endpoint = `/openapi/v1/${this.controllerId}/sites`;
    const response = await this.fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Authorization': `AccessToken=${accessToken}`,
        'Accept': 'application/json',
      },
    });

    const data = await this.parseOpenApiResponse(response);
    const sites = this.collectSiteCandidates(data.result);

    const match = sites.find((s) =>
      s.id.toLowerCase() === candidate.toLowerCase() ||
      (s.name && s.name.toLowerCase() === candidate.toLowerCase())
    );

    if (!match) {
      throw new Error(`Unable to resolve siteId for site '${candidate}'`);
    }

    return match.id;
  }

  /**
   * Find the auth record id associated with a client MAC.
   */
  private async findAuthedRecordId(siteId: string, clientMac: string): Promise<string | null> {
    if (!this.controllerId) {
      throw new Error('Client not initialized');
    }

    const accessToken = await this.getOpenApiToken();
    const normalizedTarget = this.normalizeMacForCompare(clientMac);
    const listEndpoints = [
      `/openapi/v1/${this.controllerId}/sites/${siteId}/hotspot/authed-records?page=1&pageSize=1000`,
      `/openapi/v1/${this.controllerId}/sites/${siteId}/hotspot/authed-records?currentPage=1&currentPageSize=1000`,
    ];

    for (const endpoint of listEndpoints) {
      const response = await this.fetchWithTimeout(`${this.baseUrl}${endpoint}`, {
        method: 'GET',
        headers: {
          'Authorization': `AccessToken=${accessToken}`,
          'Accept': 'application/json',
        },
      });

      const data = await this.parseOpenApiResponse(response);
      if (data.errorCode !== 0) {
        continue;
      }

      const records = this.collectRecordCandidates(data.result);
      const match = records.find((record) => {
        const recordMac = this.extractMac(record);
        return !!recordMac && this.normalizeMacForCompare(recordMac) === normalizedTarget;
      });

      if (match) {
        const recordId = this.extractRecordId(match);
        if (recordId) {
          return recordId;
        }
      }
    }

    return null;
  }

  private async parseOpenApiResponse<T = unknown>(response: Response): Promise<OmadaApiResponse<T>> {
    try {
      return (await response.json()) as OmadaApiResponse<T>;
    } catch {
      return {
        errorCode: -1,
        msg: `Failed to parse OpenAPI response (HTTP ${response.status})`,
      };
    }
  }

  private collectSiteCandidates(result: unknown): SiteInfo[] {
    const rows = this.collectRecordCandidates(result);
    return rows
      .flatMap((row): SiteInfo[] => {
        const id = typeof row.id === 'string' ? row.id : undefined;
        const name = typeof row.name === 'string'
          ? row.name
          : typeof row.siteName === 'string'
            ? row.siteName
            : undefined;
        if (!id) {
          return [];
        }
        return [{ id, name }];
      });
  }

  private collectRecordCandidates(result: unknown): Array<Record<string, unknown>> {
    const candidates: Array<Record<string, unknown>> = [];
    const stack: unknown[] = [result];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      if (Array.isArray(current)) {
        for (const item of current) {
          stack.push(item);
        }
        continue;
      }

      if (typeof current === 'object') {
        const obj = current as Record<string, unknown>;
        const values = Object.values(obj);

        if (typeof obj.id === 'string') {
          candidates.push(obj);
        }

        for (const value of values) {
          if (value && (Array.isArray(value) || typeof value === 'object')) {
            stack.push(value);
          }
        }
      }
    }

    return candidates;
  }

  private extractMac(record: Record<string, unknown>): string | null {
    const fields = ['clientMac', 'mac', 'macAddress', 'staMac'];
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  private extractRecordId(record: Record<string, unknown>): string | null {
    const fields = ['id', 'authClientId', 'authRecordId'];
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  private normalizeMacForCompare(mac: string): string {
    return mac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  }

  /** Omada's MAC form: AA-BB-CC-DD-EE-FF. */
  private formatOmadaMac(mac: string): string {
    return this.normalizeMacForCompare(mac).match(/.{2}/g)!.join('-');
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
   * An expired hotspot session (redirect to /hotspot/login, HTTP 401 or errorCode -1001)
   * triggers one re-login and a single retry; pass `retried` to disable that.
   */
  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<OmadaApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
    };

    if (this.csrfToken) {
      headers['Csrf-Token'] = this.csrfToken;
    }
    if (this.sessionId) {
      headers['Cookie'] = `${SESSION_COOKIE}=${this.sessionId}`;
    }

    const retryAfterLogin = async (): Promise<OmadaApiResponse<T>> => {
      await this.login();
      return this.request<T>(method, path, body, true);
    };

    logger.debug({ method, url }, 'Omada API request');

    try {
      const response = await this.fetchWithTimeout(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get('location')
      ) {
        const redirectUrl = new URL(response.headers.get('location')!, url);
        logger.warn({ method, url, redirectUrl: redirectUrl.toString() }, 'Omada controller redirected request');

        // The controller redirects to hotspot login when the session is stale.
        // Re-authenticate and retry the original API request instead of following the redirect URL.
        if (redirectUrl.pathname.includes('/hotspot/login')) {
          if (retried) {
            return {
              errorCode: -1001,
              msg: 'Redirected to hotspot login after retry',
            };
          }
          return retryAfterLogin();
        }

        // Follow redirects only for GET requests (e.g., initialization endpoint redirects).
        if (
          method === 'GET' &&
          !retried &&
          redirectUrl.protocol === 'https:' &&
          redirectUrl.hostname === new URL(url).hostname
        ) {
          this.baseUrl = normalizeOmadaBaseUrl(redirectUrl.origin);
          const newPath = redirectUrl.pathname + redirectUrl.search;
          return this.request(method, newPath, body, true);
        }
      }

      // Node 20's fetch exposes getSetCookie(), which keeps multiple Set-Cookie lines separate.
      const sessionCookie = response.headers.getSetCookie()
        .map((cookieLine) => cookieLine.split(';')[0].trim())
        .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
      if (sessionCookie) {
        this.sessionId = sessionCookie.substring(SESSION_COOKIE.length + 1);
      }

      const rawBody = await response.text();
      let data: OmadaApiResponse<T>;
      if (!rawBody) {
        data = { errorCode: response.ok ? 0 : -1, msg: `HTTP ${response.status}` };
      } else {
        try {
          data = JSON.parse(rawBody) as OmadaApiResponse<T>;
        } catch {
          data = {
            errorCode: -1,
            msg: `Non-JSON response from controller (HTTP ${response.status})`,
          };
        }
      }

      if ((response.status === 401 || data.errorCode === -1001) && !retried) {
        logger.warn('Hotspot session expired, re-authenticating...');
        return retryAfterLogin();
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
