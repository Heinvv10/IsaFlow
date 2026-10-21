/**
 * Recording Netcash's answer on a claim (AP-01), on the claim's own connection (netcashSubmissionClaim) or - when that
 * connection failed under the settle (a network blip, a restart, a killed backend) - once more on a fresh, briefly
 * checked-out one (round 11): an accepted answer that is only logged leaves the row 'pending', and once the send window
 * has passed an operator may free it and the batch be sent again. Both are bounded (round 12, netcashTimeouts): a
 * settle that stalls gives up, so its send slot is freed. Each settle writes a token into netcash_response, by which
 * the retry recognises a first settle that committed but lost its reply - whatever a poll changed since.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { connectWithin } from './netcashSendCapacity';
import {
  CLAIM_CONNECTION_TIMEOUT_MS, SETTLE_LOCK_TIMEOUT_MS, SETTLE_QUERY_TIMEOUT_MS, SETTLE_STATEMENT_TIMEOUT_MS,
} from './netcashTimeouts';

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

/**
 * Neither the claim's connection nor a fresh one confirmed recording Netcash's answer. It MAY still have been recorded
 * (a COMMIT whose reply was lost): the row is 'pending' or already settled - someone must look before acting.
 */
export class AnswerNotRecordedError extends Error {}

/** What the claim and settle statements need of a connection. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** `client`, with every statement given up on client-side after SETTLE_QUERY_TIMEOUT_MS (a connection gone silent). */
export function bounded(client: PoolClient): Queryable {
  return {
    query: <R extends QueryResultRow>(text: string, values?: unknown[]) =>
      client.query<R>({ text, values, query_timeout: SETTLE_QUERY_TIMEOUT_MS }),
  };
}

/** lock_timeout and statement_timeout for the rest of this transaction: the settle bounds, or tighter if already so. */
export async function tightenSettleTimeouts(q: Queryable): Promise<void> {
  await q.query(
    `SELECT set_config(s.name, v.ms::TEXT, true) FROM pg_catalog.pg_settings s
     JOIN (VALUES ('lock_timeout', $1::BIGINT), ('statement_timeout', $2::BIGINT)) AS v(name, ms) ON v.name = s.name
     WHERE s.setting::BIGINT = 0 OR s.setting::BIGINT > v.ms`,
    [SETTLE_LOCK_TIMEOUT_MS, SETTLE_STATEMENT_TIMEOUT_MS]);
}

/** Inside a transaction just begun: act as app_user with the caller's claims and active company (RLS binds it). */
export async function actAsCaller(client: Queryable, p: ClaimPrincipal): Promise<void> {
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
export async function settleRows(client: Queryable, p: ClaimPrincipal, submissionId: string, s: ClaimSettlement,
  settleToken: string): Promise<SettleResult> {
  const { rowCount } = await client.query(
    `UPDATE netcash_submissions
     SET status = $3, batch_reference = $4, netcash_response = $5::JSONB || jsonb_build_object('settleToken', $7::TEXT), submitted_at = $6
     WHERE id = $1::UUID AND company_id = $2::UUID AND status = 'pending'`,
    [submissionId, p.companyId, s.status, s.batchReference, JSON.stringify(s.netcashResponse), s.submittedAt, settleToken]);
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
 * still held, so the cap on sends in flight covers it), bounded like the first. If the first settle did commit and
 * only its reply was lost, the row carries this settle's token (`settleToken`; a poll since may have moved its status
 * or merged hints): that is reported as settled, not as a conflict. No send lock is taken - the compare-and-set on
 * 'pending' (or the late-answer branch) decides, as on the claim's connection.
 */
export async function settleOnFreshConnection(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement,
  settleToken: string): Promise<SettleResult> {
  const client = await connectWithin(getPool(), CLAIM_CONNECTION_TIMEOUT_MS);
  if (!client) throw new Error(`no connection for the settle retry within ${CLAIM_CONNECTION_TIMEOUT_MS} ms`);
  const onError = (err: Error) => log.error('netcash settle retry connection lost', { submissionId, error: err.message }, 'netcash');
  client.on('error', onError);
  const q = bounded(client);
  let unusable = false;
  let begun = false;
  try {
    await q.query('BEGIN');
    begun = true;
    await actAsCaller(q, p);
    await tightenSettleTimeouts(q);
    const { rows } = await q.query<{ ours: boolean }>(
      `SELECT (netcash_response ->> 'settleToken') IS NOT DISTINCT FROM $3::TEXT AS ours /* netcash_settle_retry */
       FROM netcash_submissions WHERE id = $1::UUID AND company_id = $2::UUID FOR UPDATE`,
      [submissionId, p.companyId, settleToken]);
    const out: SettleResult = rows[0]?.ours === true ? { kind: 'settled' } : await settleRows(q, p, submissionId, s, settleToken);
    await q.query('COMMIT');
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, 'netcash claim settle retry');
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(unusable);
  }
}
