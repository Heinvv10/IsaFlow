/**
 * Taking the automatic snapshots queued by autoSnapshotQueue (period close or
 * lock, VAT lock, year close) — after the lock has COMMITTED, on its own
 * connection, as the person who locked. One that cannot be taken (too large,
 * no signing key, an error) is recorded as a 'failed' attempt with the
 * reason; a rejected record is logged, never thrown — nothing here can reach
 * the lock, which is already committed.
 */
import { log } from '@/lib/logger';
import { SigningKeyMissingError } from './seal';
import { runAuditTx, type AuditPrincipal } from './auditTx';
import type { AutoTrigger } from './autoSnapshotQueue';
import { SnapshotTooLargeError, recordFailedSnapshot, takeSnapshot } from './snapshotService';

export function failureReason(err: unknown): string {
  if (err instanceof SnapshotTooLargeError) return `too_large: ${err.lines} journal lines (the cap is ${err.max})`;
  if (err instanceof SigningKeyMissingError) return 'signing_key_missing: the server has no audit signing key configured';
  return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
}

/**
 * Whether what the request locked is still locked now that it committed — a
 * close inside a savepoint that later rolled back queued a snapshot for a
 * lock that never happened.
 */
async function triggerHolds(p: AuditPrincipal, item: { trigger: AutoTrigger; cutoff: string }): Promise<boolean> {
  return runAuditTx(p, 'READ COMMITTED', async (client) => {
    const { rows: [r] } = await client.query<{ ok: boolean }>(item.trigger === 'vat_lock'
      ? `SELECT EXISTS (SELECT 1 FROM vat_period_locks WHERE company_id = $1::uuid AND period_end = $2::date
           AND unlocked_at IS NULL) AS ok`
      : `SELECT EXISTS (SELECT 1 FROM fiscal_periods WHERE company_id = $1::uuid AND end_date = $2::date
           AND status IN ('closed', 'locked')) AS ok`, [p.companyId, item.cutoff]);
    return r?.ok === true;
  });
}

export async function runAutoSnapshots(p: AuditPrincipal, items: { trigger: AutoTrigger; cutoff: string }[]): Promise<void> {
  for (const item of items) {
    try {
      if (!await triggerHolds(p, item)) {
        log.info('audit: automatic snapshot skipped — the lock did not stand', { companyId: p.companyId, ...item }, 'audit');
        continue;
      }
      const s = await takeSnapshot(p, { cutoff: item.cutoff, trigger: item.trigger });
      log.info('audit: automatic snapshot sealed', { companyId: p.companyId, snapshotId: s.id, trigger: item.trigger,
        cutoff: item.cutoff, lines: s.lines, durationMs: s.durationMs }, 'audit');
    } catch (err) {
      const reason = failureReason(err);
      log.warn('audit: automatic snapshot not taken', { companyId: p.companyId, trigger: item.trigger, cutoff: item.cutoff, reason }, 'audit');
      try {
        await recordFailedSnapshot(p, { ...item, reason });
      } catch (recordErr) {
        log.error('audit: could not record the failed automatic snapshot', { companyId: p.companyId, trigger: item.trigger,
          reason, error: recordErr instanceof Error ? recordErr.message : String(recordErr) }, 'audit');
      }
    }
  }
}
