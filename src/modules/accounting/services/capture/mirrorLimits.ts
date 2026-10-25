/**
 * What one company may ask of the scan cron (S-07e part B). The cron is serial and each scan
 * may run up to its 120 s deadline, so a tenant's connections are time taken from every other
 * tenant's: a scan interval below MIN makes a connection due on every tick, and unlimited
 * connections make a tick as long as their number. The due selection takes at most one
 * connection per company per tick (mirrorDueSql.ts), the interval is bounded here, and a
 * company holds at most MAX_ACTIVE_CONNECTIONS_PER_COMPANY active connections per mirror.
 */
import type pg from 'pg';

export const MIN_SCAN_INTERVAL_MINUTES = 5;
export const MAX_SCAN_INTERVAL_MINUTES = 1440;
export const MAX_ACTIVE_CONNECTIONS_PER_COMPANY = 5;

export const SCAN_INTERVAL_MESSAGE =
  `scanIntervalMinutes must be a whole number of minutes from ${MIN_SCAN_INTERVAL_MINUTES} to ${MAX_SCAN_INTERVAL_MINUTES}`;

/** The refusal message for a bad interval, or null when it is absent (the default applies) or valid. */
export function scanIntervalError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const ok = typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_SCAN_INTERVAL_MINUTES && value <= MAX_SCAN_INTERVAL_MINUTES;
  return ok ? null : SCAN_INTERVAL_MESSAGE;
}

/** A company already holds its limit of active connections on this mirror; the route answers 409. */
export class MirrorConnectionCapError extends Error {
  readonly reason = 'MIRROR_CONNECTION_CAP';
  constructor(mirror: string) {
    super(`A company can have at most ${MAX_ACTIVE_CONNECTIONS_PER_COMPANY} active ${mirror} connections; remove one first`);
    this.name = 'MirrorConnectionCapError';
  }
}

const COUNT_ACTIVE = {
  imap: `SELECT COUNT(*)::int AS n FROM imap_mirror_connections WHERE company_id = $1::uuid AND status = 'active'`,
  sent: `SELECT COUNT(*)::int AS n FROM sent_mirror_connections WHERE company_id = $1::uuid AND status = 'active'`,
} as const;
const LOCK_KEY = {
  imap: `SELECT pg_advisory_xact_lock(hashtextextended('imap_mirror_connections:' || $1::text, 0))`,
  sent: `SELECT pg_advisory_xact_lock(hashtextextended('sent_mirror_connections:' || $1::text, 0))`,
} as const;

/**
 * Inside the create's transaction: takes the company's transaction-scoped advisory lock (so two
 * concurrent creates cannot both see room for one more), then refuses at the limit.
 */
export async function assertUnderConnectionCap(client: pg.PoolClient, mirror: 'imap' | 'sent', companyId: string): Promise<void> {
  await client.query(LOCK_KEY[mirror], [companyId]);
  const { rows } = await client.query(COUNT_ACTIVE[mirror], [companyId]);
  if (Number((rows[0] as { n: number }).n) >= MAX_ACTIVE_CONNECTIONS_PER_COMPANY) {
    throw new MirrorConnectionCapError(mirror === 'imap' ? 'capture mirror' : 'sent mirror');
  }
}
