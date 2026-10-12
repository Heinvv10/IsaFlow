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
import { SnapshotBusyError, runAuditTx, type AuditPrincipal } from './auditTx';
import type { AutoTrigger } from './autoSnapshotQueue';
import { LockGoneError, SnapshotTimeBudgetError, SnapshotTooLargeError, takeAutoSnapshot } from './snapshotService';
import { lockStands, recordSnapshotAttempt } from './snapshotAttempts';

export function failureReason(err: unknown): string {
  if (err instanceof SnapshotTooLargeError) return `too_large: ${err.lines} journal lines (the cap is ${err.max})`;
  if (err instanceof SnapshotTimeBudgetError) return `too_slow: abandoned at ${err.step}`;
  if (err instanceof SigningKeyMissingError) return 'signing_key_missing: the server has no audit signing key configured';
  if (err instanceof SnapshotBusyError) return `busy: ${err.message}`;
  if (err instanceof LockGoneError) return `lock_gone: ${err.message}`;
  return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
}

/**
 * Whether what the request locked at `cutoff` is still locked now that it committed — a close inside a savepoint
 * that later rolled back queued a snapshot for a lock that never happened.
 */
async function triggerHolds(p: AuditPrincipal, trigger: AutoTrigger, cutoff: string): Promise<boolean> {
  return runAuditTx(p, 'READ COMMITTED', (client) => lockStands(client, p.companyId, trigger, cutoff));
}

async function recordFailure(p: AuditPrincipal, trigger: AutoTrigger, cutoff: string, err: unknown): Promise<void> {
  const reason = failureReason(err);
  log.warn('audit: automatic snapshot not taken', { companyId: p.companyId, trigger, cutoff, reason }, 'audit');
  try {
    await recordSnapshotAttempt(p, { cutoff, trigger, status: 'failed', reason });
  } catch (recordErr) {
    log.error('audit: could not record the failed automatic snapshot', { companyId: p.companyId, trigger,
      reason, error: recordErr instanceof Error ? recordErr.message : String(recordErr) }, 'audit');
  }
}

/**
 * One snapshot per trigger, at the latest queued cutoff whose lock stands (it covers every earlier one). If that lock
 * is undone while the snapshot waits its turn (lock_gone), the next latest standing cutoff is snapshotted instead, so
 * closing January and February together and reopening February still freezes January.
 */
export async function runAutoSnapshots(p: AuditPrincipal, items: { trigger: AutoTrigger; cutoffs: string[] }[]): Promise<void> {
  for (const { trigger, cutoffs } of items) {
    const latestFirst = [...new Set(cutoffs)].sort().reverse();
    let took = false;
    for (const cutoff of latestFirst) {
      try {
        if (!(await triggerHolds(p, trigger, cutoff))) continue;
        const s = await takeAutoSnapshot(p, { cutoff, trigger });
        took = true;
        if (s.status === 'unchanged') {
          log.info('audit: automatic snapshot unchanged', { companyId: p.companyId, trigger, cutoff, sameAs: s.sameAs }, 'audit');
        } else {
          // The chain head, outside the database too: a removed latest snapshot is visible against this log.
          log.info('audit: automatic snapshot sealed', { companyId: p.companyId, snapshotId: s.id, trigger, cutoff, seq: s.seq,
            hash: s.canonicalHash, lines: s.lines, durationMs: s.durationMs }, 'audit');
        }
        break;
      } catch (err) {
        await recordFailure(p, trigger, cutoff, err);
        took = true;
        if (!(err instanceof LockGoneError)) break; // the next cutoff would fail the same way (no key, too large, busy)
        took = false;
      }
    }
    if (!took) log.info('audit: automatic snapshot skipped — no queued lock stood', { companyId: p.companyId, trigger, cutoffs }, 'audit');
  }
}
