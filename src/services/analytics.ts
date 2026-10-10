import { prisma } from '../db';

// =============================================================================
// Dashboard Analytics
// =============================================================================

export const DASHBOARD_RANGES = [7, 14, 30] as const;
export type DashboardRange = typeof DASHBOARD_RANGES[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const AUTH_METHOD_LABELS: Record<string, string> = {
  VOUCHER: 'Voucher',
  SHARED_PASSWORD: 'Password',
  CLICK_THROUGH: 'Click-through',
};

/** Omada radioId -> band. */
const BAND_LABELS: Record<string, string> = {
  '0': '2.4 GHz',
  '1': '5 GHz',
  '2': '6 GHz',
};

const VOUCHER_STATUSES = ['UNUSED', 'ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED'] as const;

export interface CountItem {
  label: string;
  value: number;
}

export interface DashboardAnalytics {
  rangeDays: DashboardRange;
  kpis: {
    activeSessions: number;
    connections: number;
    previousConnections: number;
    failedLogins: number;
    successRate: number | null;
    unusedVouchers: number;
    totalVouchers: number;
  };
  daily: { labels: string[]; connections: number[]; failed: number[] };
  hourly: number[];
  authMethods: CountItem[];
  bands: CountItem[];
  osTypes: CountItem[];
  deviceTypes: CountItem[];
  voucherStatus: CountItem[];
  activeSessionList: Array<{
    id: string;
    clientMac: string;
    ssidName: string;
    authMethod: string;
    band: string;
    startedAt: Date;
    expiresAt: Date;
  }>;
}

export function parseDashboardRange(value: unknown): DashboardRange {
  const days = Number(value);
  return (DASHBOARD_RANGES as readonly number[]).includes(days) ? (days as DashboardRange) : 14;
}

/** Local calendar day key (YYYY-MM-DD) in the container's TZ. */
function dayKey(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

function countBy<T>(items: T[], keyOf: (item: T) => string, labels: Record<string, string>): CountItem[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ label: labels[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);
}

export async function getDashboardAnalytics(rangeDays: DashboardRange): Promise<DashboardAnalytics> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rangeStart = new Date(startOfToday.getTime() - (rangeDays - 1) * DAY_MS);
  const previousStart = new Date(rangeStart.getTime() - rangeDays * DAY_MS);
  const activeWhere = { status: 'ACTIVE', expiresAt: { gt: now } };

  const [sessions, previousConnections, failedLogins, voucherGroups, activeSessions] = await Promise.all([
    prisma.guestSession.findMany({
      where: { startedAt: { gte: rangeStart } },
      select: { startedAt: true, authMethod: true, radioId: true, osType: true, deviceType: true },
    }),
    prisma.guestSession.count({ where: { startedAt: { gte: previousStart, lt: rangeStart } } }),
    prisma.auditLog.findMany({
      where: { action: 'GUEST_LOGIN_FAILED', timestamp: { gte: rangeStart } },
      select: { timestamp: true },
    }),
    prisma.voucher.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.guestSession.findMany({
      where: activeWhere,
      orderBy: { startedAt: 'desc' },
      select: {
        id: true, clientMac: true, ssidName: true, authMethod: true,
        radioId: true, startedAt: true, expiresAt: true,
      },
    }),
  ]);

  const labels: string[] = [];
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < rangeDays; i++) {
    const day = new Date(rangeStart.getTime() + i * DAY_MS);
    dayIndex.set(dayKey(day), i);
    labels.push(day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }

  const connections = new Array<number>(rangeDays).fill(0);
  const failed = new Array<number>(rangeDays).fill(0);
  const hourly = new Array<number>(24).fill(0);

  for (const session of sessions) {
    const i = dayIndex.get(dayKey(session.startedAt));
    if (i !== undefined) connections[i]++;
    hourly[session.startedAt.getHours()]++;
  }
  for (const log of failedLogins) {
    const i = dayIndex.get(dayKey(log.timestamp));
    if (i !== undefined) failed[i]++;
  }

  const voucherCounts = new Map(voucherGroups.map((g) => [g.status, g._count._all]));
  const attempts = sessions.length + failedLogins.length;

  return {
    rangeDays,
    kpis: {
      activeSessions: activeSessions.length,
      connections: sessions.length,
      previousConnections,
      failedLogins: failedLogins.length,
      successRate: attempts > 0 ? sessions.length / attempts : null,
      unusedVouchers: voucherCounts.get('UNUSED') ?? 0,
      totalVouchers: voucherGroups.reduce((sum, g) => sum + g._count._all, 0),
    },
    daily: { labels, connections, failed },
    hourly,
    authMethods: countBy(sessions, (s) => s.authMethod, AUTH_METHOD_LABELS),
    bands: countBy(sessions, (s) => String(s.radioId), BAND_LABELS),
    osTypes: countBy(sessions, (s) => s.osType ?? 'UNKNOWN', { UNKNOWN: 'Unknown' }),
    deviceTypes: countBy(sessions, (s) => s.deviceType ?? 'UNKNOWN', { UNKNOWN: 'Unknown' }),
    voucherStatus: VOUCHER_STATUSES.map((status) => ({
      label: status.charAt(0) + status.slice(1).toLowerCase(),
      value: voucherCounts.get(status) ?? 0,
    })),
    activeSessionList: activeSessions.map((s) => ({
      id: s.id,
      clientMac: s.clientMac,
      ssidName: s.ssidName,
      authMethod: AUTH_METHOD_LABELS[s.authMethod] ?? s.authMethod,
      band: BAND_LABELS[String(s.radioId)] ?? `Radio ${s.radioId}`,
      startedAt: s.startedAt,
      expiresAt: s.expiresAt,
    })),
  };
}
