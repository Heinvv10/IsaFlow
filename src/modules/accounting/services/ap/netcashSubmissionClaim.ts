/**
 * The durable claim on a supplier payment batch's Netcash submission (AP-01).
 *
 * A batch must go to Netcash once. The claim row (netcash_submissions, status
 * 'pending', batch_id; at most one non-failed row per batch by migration 898)
 * is written in its OWN committed transaction BEFORE the send, and settled in
 * another AFTER it. It must not live in the request's transaction: withAuth
 * rolls that back on any >=500 and on a crash or timeout, and with it the only
 * record that the batch may already have been paid.
 *
 * Both run on ONE pooled connection held from the claim to `end()` (never the
 * request's; the same shape as audit/auditTx.runAuditTx), as app_user with the
 * caller's claims and active company, so RLS binds it and every statement still
 * carries its company_id. That connection holds the claim's send lock
 * (services/ap/netcashSendLock), taken inside the claim transaction before it
 * commits and released after the settle: netcash/resolve refuses while it is
 * held, so a stalled or paused sender keeps its claim. It costs one connection
 * per send in flight for up to the send timeout - the claim and settle used one
 * each before - so sends are capped and the checkout bounded (netcashSendCapacity:
 * refused before anything is claimed). A connection that cannot be unlocked is
 * destroyed, never pooled with the lock on it; a dead process or connection drops
 * the lock by itself.
 *
 * A claim left 'pending' (the process died between the send and the settle, or
 * the settle failed) blocks resubmission exactly like 'unknown': it is in the
 * partial unique index. An owner/admin clears it once Netcash has been checked, with POST /api/accounting/netcash/resolve
 * (services/ap/netcashSubmissionResolve: 'failed' = Netcash never got it, the batch may be sent again; 'submitted' =
 * Netcash has it, the batch stays closed; a note is required, compare-and-set, audit-logged) - not by raw UPDATE.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { NETCASH_SEND_LOCK_CLASS } from './netcashSendLock';
import { connectWithin, takeSendSlot } from './netcashSendCapacity';
import { CLAIM_CONNECTION_TIMEOUT_MS, SETTLE_QUERY_TIMEOUT_MS } from './netcashTimeouts';
import {
  actAsCaller, AnswerNotRecordedError, bounded, settleOnFreshConnection, settleRows, tightenSettleTimeouts, type Queryable,
  type ClaimPrincipal, type ClaimSettlement, type SettleResult,
} from './netcashClaimSettle';

export { AnswerNotRecordedError, type ClaimPrincipal, type ClaimSettlement, type SettleResult };

export interface BatchClaim {
  batchId: string;
  batchReference: string | null;
  totalAmountCents: number;
  recordCount: number;
  createdBy: string;
}

/** The claim's connection: whether it holds the send lock, and whether it must be destroyed rather than pooled. */
interface ClaimConnection {
  client: PoolClient; locked: boolean; unusable: boolean; ended: boolean; onError: (err: Error) => void; freeSlot: () => void;
}

/**
 * One committed transaction on the claim's connection, as app_user in the caller's company. `settle`: bounded
 * (round 12) - every statement given up on client-side after SETTLE_QUERY_TIMEOUT_MS and lock_timeout /
 * statement_timeout tightened - so a settle that stalls throws instead of holding its send slot.
 */
async function committed<T>(conn: ClaimConnection, p: ClaimPrincipal, label: string, fn: (q: Queryable) => Promise<T>,
  settle = false): Promise<T> {
  const { client } = conn;
  const q: Queryable = settle ? bounded(client) : client;
  let begun = false;
  try {
    await q.query('BEGIN');
    begun = true;
    await actAsCaller(q, p);
    if (settle) await tightenSettleTimeouts(q);
    const out = await fn(q);
    await q.query('COMMIT');
    return out;
  } catch (err) {
    if (begun && await rollbackFailed(client, `netcash claim ${label}`)) conn.unusable = true;
    log.error('netcash claim transaction rolled back', {
      label, companyId: p.companyId, error: err instanceof Error ? err.message : String(err),
    }, 'netcash');
    throw err;
  }
}

/**
 * Release the send lock and give the connection back. Destroyed instead (a session lock must never go back to the
 * pool) when a ROLLBACK on it failed (`unusable`, from rollbackFailed in committed()), when the lock was taken but the
 * claim did not commit, or when the unlock failed or found no lock. Never throws.
 */
async function endClaim(conn: ClaimConnection, submissionId: string | null, keepSlot = false): Promise<void> {
  if (conn.ended) {
    if (!keepSlot) conn.freeSlot();
    return;
  }
  conn.ended = true;
  const { client } = conn;
  let unlockFailed: unknown = null;
  if (conn.locked && !conn.unusable && submissionId) {
    try {
      // Bounded like the settle: an unlock on a connection gone silent must not hold the send slot either.
      const { rows } = await client.query<{ ok: boolean }>({
        text: 'SELECT pg_advisory_unlock($1::INT4, hashtext($2::UUID::TEXT)) AS ok',
        values: [NETCASH_SEND_LOCK_CLASS, submissionId], query_timeout: SETTLE_QUERY_TIMEOUT_MS,
      });
      if (rows[0]?.ok !== true) unlockFailed = new Error('send lock was not held');
    } catch (err) {
      unlockFailed = err;
    }
    if (unlockFailed) log.error('netcash send lock not released - connection destroyed', { submissionId, error: String(unlockFailed) }, 'netcash');
  }
  client.removeListener('error', conn.onError);
  client.release(conn.unusable || (conn.locked && !submissionId) || Boolean(unlockFailed));
  if (!keepSlot) conn.freeSlot();
}

/** A claim whose connection holds its send lock until `end()`. */
export interface HeldClaim {
  id: string;
  /** Record what Netcash answered (see settleOn). */
  settle(s: ClaimSettlement): Promise<SettleResult>;
  /** Release the send lock and the connection, after the settle (or after it failed). Never throws. */
  end(): Promise<void>;
}

/**
 * What a claim attempt came to. `held`: a live (non-failed) submission already holds the batch. `busy`: refused
 * before anything was claimed or sent - `sends` (the in-process cap is reached), `connection` (no claim connection
 * within CLAIM_CONNECTION_TIMEOUT_MS) or `lock` (the send lock's key is held: a hashtext collision with a live send;
 * the claim was rolled back).
 */
export type ClaimOutcome =
  | { kind: 'claimed'; claim: HeldClaim }
  | { kind: 'held' }
  | { kind: 'busy'; reason: 'sends' | 'company_sends' | 'connection' | 'lock' };

class SendLockBusy extends Error {}

/**
 * Claim the batch and take its send lock. On `claimed` the caller MUST call `claim.end()` once the send is settled
 * (try/finally); every other outcome has already given everything back.
 */
export async function claimBatch(p: ClaimPrincipal, c: BatchClaim): Promise<ClaimOutcome> {
  const slot = takeSendSlot(p.companyId);
  if ('refused' in slot) return { kind: 'busy', reason: slot.refused === 'company' ? 'company_sends' : 'sends' };
  const freeSlot = slot.free;
  let client: PoolClient | null;
  try {
    client = await connectWithin(getPool(), CLAIM_CONNECTION_TIMEOUT_MS);
  } catch (err) {
    freeSlot();
    throw err;
  }
  if (!client) {
    freeSlot();
    return { kind: 'busy', reason: 'connection' };
  }
  // A checked-out client has no 'error' listener (pg-pool removes its own): a backend that dies during the send
  // would otherwise crash the process. The settle then fails on it and the claim stays 'pending'.
  const onError = (err: Error) => log.error('netcash send connection lost', { companyId: p.companyId, error: err.message }, 'netcash');
  client.on('error', onError);
  const conn: ClaimConnection = { client, locked: false, unusable: false, ended: false, onError, freeSlot };
  let id: string | null;
  try {
    id = await committed(conn, p, 'claim', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO netcash_submissions (
           company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, batch_id
         ) VALUES ($1::UUID, 'eft_payment', $2, $3, $4, 'pending', $5, $6::UUID)
         ON CONFLICT (company_id, batch_id) WHERE batch_id IS NOT NULL AND status <> 'failed' DO NOTHING
         RETURNING id`,
        [p.companyId, c.batchReference, c.totalAmountCents, c.recordCount, c.createdBy, c.batchId]);
      const claimed = rows[0]?.id ?? null;
      // Before COMMIT: nobody can see this 'pending' row without its sender holding the lock. A SESSION lock (it
      // outlives the transaction), TRY-locked: the key is a 32-bit hash of a new id, so it is free unless it collides
      // with a live send's; waiting would hold this uncommitted claim open for that whole send. A collision rolls the
      // claim back (SendLockBusy) and the submit is refused, to be tried again.
      if (claimed) {
        const { rows: got } = await tx.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1::INT4, hashtext($2::UUID::TEXT)) AS ok', [NETCASH_SEND_LOCK_CLASS, claimed]);
        if (got[0]?.ok !== true) throw new SendLockBusy(`send lock key of ${claimed} is held`);
        conn.locked = true;
      }
      return claimed;
    });
  } catch (err) {
    // A claim that failed after the lock keeps it on this session: the connection is destroyed, not pooled.
    await endClaim(conn, null);
    if (err instanceof SendLockBusy) return { kind: 'busy', reason: 'lock' };
    throw err;
  }
  if (!id) {
    await endClaim(conn, null);
    return { kind: 'held' };
  }
  const claimId = id;
  return { kind: 'claimed', claim: { id: claimId, settle: (s) => settleOn(conn, p, claimId, s), end: () => endClaim(conn, claimId) } };
}

/**
 * Record Netcash's answer: on the claim's connection, and if that fails, once more on a fresh connection
 * (netcashClaimSettle.settleOnFreshConnection) - the answer must reach the row, or an operator may later free a batch
 * Netcash accepted. If both fail the row stays 'pending' (the batch closed), the full answer is logged, and
 * AnswerNotRecordedError is thrown for the caller to say what Netcash answered.
 */
async function settleOn(conn: ClaimConnection, p: ClaimPrincipal, submissionId: string, s: ClaimSettlement): Promise<SettleResult> {
  const settleToken = randomUUID(); // this send's answer, recognisable by the retry whatever a poll changes meanwhile
  try {
    return await committed(conn, p, 'settle', (q) => settleRows(q, p, submissionId, s, settleToken), true);
  } catch (first) {
    log.error('netcash settle failed on the claim connection - retrying once on a fresh connection', {
      submissionId, status: s.status, error: first instanceof Error ? first.message : String(first),
    }, 'netcash');
    // A connection whose ROLLBACK failed may still hold the settle's row lock (a statement it stopped answering
    // for): drop it now, keeping the send slot, so the retry does not wait on it.
    if (conn.unusable) await endClaim(conn, submissionId, true);
    try {
      return await settleOnFreshConnection(p, submissionId, s, settleToken);
    } catch (second) {
      log.error('netcash answer may NOT have been recorded - check the submission row and Netcash; do not resend', {
        submissionId, status: s.status, batchReference: s.batchReference, answer: s.netcashResponse,
        firstError: first instanceof Error ? first.message : String(first), retryError: second instanceof Error ? second.message : String(second),
      }, 'netcash');
      throw new AnswerNotRecordedError(`Netcash's answer for submission ${submissionId} may not have been recorded`);
    }
  }
}
