/**
 * Health-alert debounce state in admin_settings, and the claim that stops two
 * passes sending the same alert (admin audit OP-1, review M1).
 *
 * Two callers run checkAndAlert: the 5-minute cron pass and every open
 * /admin/health tab. Reading the state, sending, then saving let both send at
 * a transition. Now the decision is a CLAIM: one short transaction holds a
 * transaction-scoped advisory lock on a fixed key, reads the state, decides,
 * and writes the new state (status + sent-at) before anything is sent. The
 * second pass waits on the lock, then reads the claimed state and is
 * suppressed. Sending happens after COMMIT, outside the transaction.
 *
 * If no channel delivers, the claim is RELEASED (review L-b): the previous
 * state is written back under the same lock, so the next pass retries. Only
 * when the state is still this claim's; a later claim or a healthy reset wins.
 *
 * The keys are platform-global (admin_settings has no company_id). Values are
 * JSONB scalars: a string is stored as a JSON string.
 */

import { withTransaction, type TxSql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type AlertableStatus = 'degraded' | 'critical';

export const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const STATUS_KEY = 'health_alert_last_status';
const SENT_AT_KEY = 'health_alert_last_sent_at';
/** Written by each successful scheduled pass; the Health page shows whether the timer runs (review M2). */
export const SCHEDULED_RUN_KEY = 'health_alerts_last_scheduled_run';

const LOCK_KEY = 'admin:health-alert-state';
/** What a released claim writes back for "never sent": cooldown long over, so the next pass may alert. */
const NEVER = new Date(0).toISOString();

interface RawState { status: string | null; sentAt: string | null }

export interface AlertClaim {
  status: AlertableStatus;
  claimedAt: string;
  previous: RawState;
}

/** A JSONB scalar as pg hands it back: a parsed value, or text that may still be JSON. */
export function settingText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'string' ? parsed : String(parsed);
    } catch {
      return raw;
    }
  }
  return String(raw);
}

async function lock(tx: TxSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`;
}

async function readState(tx: TxSql): Promise<RawState> {
  const rows = await tx`
    SELECT key, value FROM admin_settings WHERE key IN (${STATUS_KEY}, ${SENT_AT_KEY})
  ` as DbRow[];
  const map = new Map(rows.map((r) => [String(r.key ?? ''), settingText(r.value)]));
  return { status: map.get(STATUS_KEY) ?? null, sentAt: map.get(SENT_AT_KEY) ?? null };
}

async function write(tx: TxSql, key: string, value: string): Promise<void> {
  await tx`
    INSERT INTO admin_settings (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export function shouldAlert(state: RawState, status: string, now = Date.now()): boolean {
  if (state.status !== status) return true;
  if (!state.sentAt) return true;
  const sentAt = new Date(state.sentAt).getTime();
  return Number.isNaN(sentAt) || now - sentAt > ALERT_COOLDOWN_MS;
}

/**
 * Claim the right to send `status`: null when the state says it was already
 * sent (debounced), else the claim, with the state already written.
 */
export async function claimAlert(status: AlertableStatus): Promise<AlertClaim | null> {
  return withTransaction(async (tx) => {
    await lock(tx);
    const previous = await readState(tx);
    if (!shouldAlert(previous, status)) return null;
    const claimedAt = new Date().toISOString();
    await write(tx, STATUS_KEY, status);
    await write(tx, SENT_AT_KEY, claimedAt);
    return { status, claimedAt, previous };
  });
}

/** Undo a claim whose alert reached no channel. False when another pass changed the state since. */
export async function releaseClaim(claim: AlertClaim): Promise<boolean> {
  return withTransaction(async (tx) => {
    await lock(tx);
    const current = await readState(tx);
    if (current.status !== claim.status || current.sentAt !== claim.claimedAt) return false;
    // Written, not DELETEd (these keys have only ever been upserted by the app pool):
    // "none" becomes healthy / the epoch, which shouldAlert treats as an absent row.
    await write(tx, STATUS_KEY, claim.previous.status ?? 'healthy');
    await write(tx, SENT_AT_KEY, claim.previous.sentAt ?? NEVER);
    return true;
  });
}

/** Healthy: clear the status so the next degraded/critical always alerts. */
export async function markHealthy(): Promise<void> {
  await withTransaction(async (tx) => {
    await lock(tx);
    await write(tx, STATUS_KEY, 'healthy');
  });
}

export async function recordScheduledRun(at: Date = new Date()): Promise<void> {
  await withTransaction(async (tx) => { await write(tx, SCHEDULED_RUN_KEY, at.toISOString()); });
}
