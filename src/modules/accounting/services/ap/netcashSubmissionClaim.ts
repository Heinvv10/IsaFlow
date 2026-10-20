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
 * each before. A connection that cannot be unlocked is destroyed, never pooled
 * with the lock on it; a dead process or connection drops the lock by itself.
 *
 * A claim left 'pending' (the process died between the send and the settle, or
 * the settle failed) blocks resubmission exactly like 'unknown': it is in the
 * partial unique index. An owner/admin clears it once Netcash has been checked, with POST /api/accounting/netcash/resolve
 * (services/ap/netcashSubmissionResolve: 'failed' = Netcash never got it, the batch may be sent again; 'submitted' =
 * Netcash has it, the batch stays closed; a note is required, compare-and-set, audit-logged) - not by raw UPDATE.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { NETCASH_SEND_LOCK_CLASS } from './netcashSendLock';

export interface ClaimPrincipal {
  companyId: string;
  /** The request's JWT claims: the RLS policies read the user from them. */
  claims: Record<string, unknown>;
}

export interface BatchClaim {
  batchId: string;
  batchReference: string | null;
  totalAmountCents: number;
  recordCount: number;
  createdBy: string;
}

export interface ClaimSettlement {
  status: 'submitted' | 'failed' | 'unknown';
  batchReference: string | null;
  netcashResponse: unknown;
  submittedAt: string | null;
}

/** The claim's connection: whether it holds the send lock, and whether it must be destroyed rather than pooled. */
interface ClaimConnection { client: PoolClient; locked: boolean; unusable: boolean; ended: boolean; onError: (err: Error) => void }

/** One committed transaction on the claim's connection, as app_user in the caller's company. */
async function committed<T>(conn: ClaimConnection, p: ClaimPrincipal, label: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const { client } = conn;
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    const out = await fn(client);
    await client.query('COMMIT');
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
async function endClaim(conn: ClaimConnection, submissionId: string | null): Promise<void> {
  if (conn.ended) return;
  conn.ended = true;
  const { client } = conn;
  let unlockFailed: unknown = null;
  if (conn.locked && !conn.unusable && submissionId) {
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_advisory_unlock($1::INT4, hashtext($2::UUID::TEXT)) AS ok', [NETCASH_SEND_LOCK_CLASS, submissionId]);
      if (rows[0]?.ok !== true) unlockFailed = new Error('send lock was not held');
    } catch (err) {
      unlockFailed = err;
    }
    if (unlockFailed) log.error('netcash send lock not released - connection destroyed', { submissionId, error: String(unlockFailed) }, 'netcash');
  }
  client.removeListener('error', conn.onError);
  client.release(conn.unusable || (conn.locked && !submissionId) || Boolean(unlockFailed));
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
 * Claim the batch and take its send lock: the claim, or null when a live (non-failed) submission already holds it.
 * The caller MUST call `end()` once the send is settled (try/finally).
 */
export async function claimBatch(p: ClaimPrincipal, c: BatchClaim): Promise<HeldClaim | null> {
  const client = await getPool().connect();
  // A checked-out client has no 'error' listener (pg-pool removes its own): a backend that dies during the send
  // would otherwise crash the process. The settle then fails on it and the claim stays 'pending'.
  const onError = (err: Error) => log.error('netcash send connection lost', { companyId: p.companyId, error: err.message }, 'netcash');
  client.on('error', onError);
  const conn: ClaimConnection = { client, locked: false, unusable: false, ended: false, onError };
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
      // Before COMMIT: nobody can see this 'pending' row without its sender holding the lock. A session lock - it
      // outlives the transaction - on a key no one else holds (a new id), so it does not wait.
      if (claimed) {
        await tx.query('SELECT pg_advisory_lock($1::INT4, hashtext($2::UUID::TEXT))', [NETCASH_SEND_LOCK_CLASS, claimed]);
        conn.locked = true;
      }
      return claimed;
    });
  } catch (err) {
    // A claim that failed after the lock keeps it on this session: the connection is destroyed, not pooled.
    await endClaim(conn, null);
    throw err;
  }
  if (!id) {
    await endClaim(conn, null);
    return null;
  }
  const claimId = id;
  return { id: claimId, settle: (s) => settleOn(conn, p, claimId, s), end: () => endClaim(conn, claimId) };
}

/**
 * 'settled', or 'lost': the claim was no longer 'pending' - `status` is what it is now. A late answer that found the
 * row 'failed' and put it back is `reopened`; one that could not, because a newer claim holds the batch, names it.
 */
export type SettleResult =
  | { kind: 'settled' }
  | { kind: 'lost'; status: string; reopened?: boolean; newerSubmissionId?: string | null };

/**
 * Record what Netcash answered on the claim - compare-and-set on 'pending': a claim released while the send was in
 * flight is NOT overwritten as such; the answer is kept on the row as `lateSendResult`. Defence in depth (round 10):
 * if Netcash accepted (or may have) and the row says 'failed', the batch could be sent again, so the row is put back
 * to 'submitted'/'unknown' (compare-and-set on 'failed'). If a newer claim already holds the batch the unique index
 * refuses it (23505, inside a savepoint): the row stays 'failed' and the newer claim is named. If this throws the
 * claim stays 'pending' and the batch closed.
 */
function settleOn(conn: ClaimConnection, p: ClaimPrincipal, submissionId: string, s: ClaimSettlement): Promise<SettleResult> {
  return committed(conn, p, 'settle', async (client): Promise<SettleResult> => {
    const { rowCount } = await client.query(
      `UPDATE netcash_submissions
       SET status = $3, batch_reference = $4, netcash_response = $5::JSONB, submitted_at = $6
       WHERE id = $1::UUID AND company_id = $2::UUID AND status = 'pending'`,
      [submissionId, p.companyId, s.status, s.batchReference, JSON.stringify(s.netcashResponse), s.submittedAt]);
    if (rowCount === 1) return { kind: 'settled' };
    const { rows } = await client.query<{ status: string; batch_id: string | null }>(
      `UPDATE netcash_submissions
       SET netcash_response = COALESCE(netcash_response, '{}'::JSONB) || jsonb_build_object('lateSendResult', $3::JSONB)
       WHERE id = $1::UUID AND company_id = $2::UUID
       RETURNING status, batch_id`,
      [submissionId, p.companyId, JSON.stringify({ status: s.status, batchReference: s.batchReference, response: s.netcashResponse })]);
    if (!rows[0]) throw new Error(`netcash claim ${submissionId} not found for settlement`);
    if (rows[0].status !== 'failed' || s.status === 'failed') return { kind: 'lost', status: rows[0].status };
    await client.query('SAVEPOINT netcash_reopen');
    try {
      await client.query(
        `UPDATE netcash_submissions SET status = $3, batch_reference = $4, submitted_at = COALESCE(submitted_at, $5)
         WHERE id = $1::UUID AND company_id = $2::UUID AND status = 'failed'`,
        [submissionId, p.companyId, s.status, s.batchReference, s.submittedAt]);
      await client.query('RELEASE SAVEPOINT netcash_reopen');
      return { kind: 'lost', status: s.status, reopened: true };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      await client.query('ROLLBACK TO SAVEPOINT netcash_reopen');
      const { rows: newer } = await client.query<{ id: string }>(
        `SELECT id FROM netcash_submissions
         WHERE company_id = $1::UUID AND batch_id = $2::UUID AND status <> 'failed' AND id <> $3::UUID LIMIT 1`,
        [p.companyId, rows[0].batch_id, submissionId]);
      return { kind: 'lost', status: 'failed', newerSubmissionId: newer[0]?.id ?? null };
    }
  });
}
