/**
 * The detached settler (AP-01 round 13). When both bounded settle attempts fail (a row lock or a slow database that
 * outlasts them), the request answers 500 and frees its send slot - but Netcash's answer must still reach the row:
 * left 'pending', it can be released once the send window has passed and the batch be sent again. So the answer is
 * handed here, and retried in the background with the SAME settle (settleOnFreshConnection: the same token, the same
 * compare-and-set on 'pending', the same late-answer branch), backing off from LATE_SETTLE_FIRST_DELAY_MS to
 * LATE_SETTLE_MAX_DELAY_MS, each attempt on a fresh bounded checkout, for NETCASH_LATE_SETTLE_TOTAL_MS in all. It holds
 * no send slot. While it runs, netcash/resolve refuses the submission (ANSWER_PENDING_RECORD).
 *
 * In-process only: a restart drops it. The 500 body and the log.error then still carry the answer (outcome and
 * reference) for the operator.
 */
import { log } from '@/lib/logger';
import { settleOnFreshConnection, type ClaimPrincipal, type ClaimSettlement } from './netcashClaimSettle';
import { DEFAULT_LATE_SETTLE_TOTAL_MS, LATE_SETTLE_FIRST_DELAY_MS, LATE_SETTLE_MAX_DELAY_MS } from './netcashTimeouts';

const live = new Set<string>();

/** Whether this process is still writing Netcash's answer for `submissionId`. */
export function isAnswerPendingRecord(submissionId: string): boolean {
  return live.has(submissionId.toLowerCase());
}

/** NETCASH_LATE_SETTLE_TOTAL_MS, read per start: whole milliseconds up to 100 minutes; anything else gives the default. */
function totalMs(): number {
  const raw = process.env.NETCASH_LATE_SETTLE_TOTAL_MS?.trim();
  if (!raw) return DEFAULT_LATE_SETTLE_TOTAL_MS;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (n >= 1 && n <= 10 * DEFAULT_LATE_SETTLE_TOTAL_MS) return n;
  log.warn('NETCASH_LATE_SETTLE_TOTAL_MS is not a whole number of milliseconds in range; using the default', { length: raw.length }, 'netcash');
  return DEFAULT_LATE_SETTLE_TOTAL_MS;
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/** Start the detached settler for this answer. Never throws; every outcome is logged. */
export function startLateSettle(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement, settleToken: string): void {
  const key = submissionId.toLowerCase();
  if (live.has(key)) return;
  live.add(key);
  void run(p, submissionId, s, settleToken).finally(() => live.delete(key));
}

async function run(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement, settleToken: string): Promise<void> {
  const deadline = Date.now() + totalMs();
  const answer = { submissionId, status: s.status, batchReference: s.batchReference, answer: s.netcashResponse };
  let delay = LATE_SETTLE_FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    await sleep(Math.max(0, Math.min(delay, deadline - Date.now())));
    try {
      const result = await settleOnFreshConnection(p, submissionId, s, settleToken);
      log.info('netcash late settler recorded the answer', { ...answer, attempt, result }, 'netcash');
      if (result.kind === 'lost' && result.newerSubmissionId !== undefined) {
        log.error('netcash late settler: a newer claim holds the batch - it may be paid twice', { ...answer, result }, 'netcash');
      }
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        log.error('netcash late settler gave up - the answer is NOT on the row; check Netcash, do not resend', { ...answer, attempt, error }, 'netcash');
        return;
      }
      log.warn('netcash late settler attempt failed - retrying', { submissionId, attempt, error }, 'netcash');
      delay = Math.min(delay * 2, LATE_SETTLE_MAX_DELAY_MS);
    }
  }
}
