/**
 * Recording Netcash's answer on a claim (AP-01), on the claim's own connection (netcashSubmissionClaim) or - when that
 * connection failed under the settle (a network blip, a restart, a killed backend) - once more on a fresh, briefly
 * checked-out one (round 11): an accepted answer that is only logged leaves the row 'pending', and once the send window
 * has passed an operator may free it and the batch be sent again.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { connectWithin } from './netcashSendCapacity';
import { CLAIM_CONNECTION_TIMEOUT_MS } from './netcashTimeouts';

export interface ClaimPrincipal {
  companyId: string;
  /** The request's JWT claims: the RLS policies read the user from them. */
  claims: Record<string, unknown>;
}

export interface ClaimSettlement {
  status: 'submitted' | 'failed' | 'unknown';
  batchReference: string | null;
  netcashResponse: unknown;
  submittedAt: string | null;
}

/**
 * 'settled', or 'lost': the claim was no longer 'pending' - `status` is what it is now. A late answer that found the
 * row 'failed' and put it back is `reopened`; one that could not, because a newer claim holds the batch, names it.
 */
export type SettleResult =
  | { kind: 'settled' }
  | { kind: 'lost'; status: string; reopened?: boolean; newerSubmissionId?: string | null };

/** Neither the claim's connection nor a fresh one could record Netcash's answer: the row stays 'pending'. */
export class AnswerNotRecordedError extends Error {}

/** Inside a transaction just begun: act as app_user with the caller's claims and active company (RLS binds it). */
export async function actAsCaller(client: PoolClient, p: ClaimPrincipal): Promise<void> {
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
}

/**
 * Record what Netcash answered on the claim - compare-and-set on 'pending': a claim released while the send was in
 * flight is NOT overwritten as such; the answer is kept on the row as `lateSendResult`. Defence in depth (round 10):
 * if Netcash accepted (or may have) and the row says 'failed', the batch could be sent again, so the row is put back
 * to 'submitted'/'unknown' (compare-and-set on 'failed'). If a newer claim already holds the batch the unique index
 * refuses it (23505, inside a savepoint): the row stays 'failed' and the newer claim is named. Inside a transaction.
 */
export async function settleRows(client: PoolClient, p: ClaimPrincipal, submissionId: string, s: ClaimSettlement): Promise<SettleResult> {
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
}

/**
 * The settle, once more, on a fresh connection checked out within CLAIM_CONNECTION_TIMEOUT_MS (the send's slot is
 * still held, so the cap on sends in flight covers it). If the first settle did commit and only its reply was lost,
 * the row already carries exactly this answer: that is reported as settled, not as a conflict. No send lock is taken -
 * the compare-and-set on 'pending' (or the late-answer branch) decides, as on the claim's connection.
 */
export async function settleOnFreshConnection(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement): Promise<SettleResult> {
  const client = await connectWithin(getPool(), CLAIM_CONNECTION_TIMEOUT_MS);
  if (!client) throw new Error(`no connection for the settle retry within ${CLAIM_CONNECTION_TIMEOUT_MS} ms`);
  const onError = (err: Error) => log.error('netcash settle retry connection lost', { submissionId, error: err.message }, 'netcash');
  client.on('error', onError);
  let unusable = false;
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await actAsCaller(client, p);
    const { rows } = await client.query<{ ours: boolean }>(
      `SELECT (status = $3 AND netcash_response = $4::JSONB) AS ours /* netcash_settle_retry */
       FROM netcash_submissions WHERE id = $1::UUID AND company_id = $2::UUID FOR UPDATE`,
      [submissionId, p.companyId, s.status, JSON.stringify(s.netcashResponse)]);
    const out: SettleResult = rows[0]?.ours === true ? { kind: 'settled' } : await settleRows(client, p, submissionId, s);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, 'netcash claim settle retry');
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(unusable);
  }
}
