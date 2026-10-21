/**
 * A Netcash answer the settle could not record, kept durably (AP-01 round 14). When both bounded settle attempts fail,
 * the answer is written to audit_log in its own short transaction - a table that needs no lock on the submission row
 * (which is what stalled the settle) and survives a restart, unlike the late settler's in-process guard. resolve then
 * refuses to FREE a still-pending submission whose recorded answer is an acceptance, in any process (once a settle
 * writes the answer - its token on the row - the row is no longer pending).
 * No migration: audit_log is append-only (880) and only inserted into. If this insert fails too, the 500 body and the
 * log.error are all that carry the answer (the documented residual).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { actAsCaller, bounded, tightenSettleTimeouts, type ClaimPrincipal, type ClaimSettlement } from './netcashClaimSettle';
import { connectWithin } from './netcashSendCapacity';
import { CLAIM_CONNECTION_TIMEOUT_MS } from './netcashTimeouts';

export const UNRECORDED_ANSWER_ENTITY = 'netcash_unrecorded_answer';

/** Netcash's word for the answer ('accepted' / 'rejected' / 'unknown'), else the status it settles to. */
function outcomeOf(s: ClaimSettlement): string {
  const o = (s.netcashResponse as { outcome?: unknown } | null)?.outcome;
  return typeof o === 'string' ? o : s.status;
}

/** Write the answer to audit_log, committed on its own bounded connection. true when written; never throws. */
export async function recordUnrecordedAnswer(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement,
  settleToken: string): Promise<boolean> {
  try {
    const client = await connectWithin(getPool(), CLAIM_CONNECTION_TIMEOUT_MS);
    if (!client) throw new Error(`no connection within ${CLAIM_CONNECTION_TIMEOUT_MS} ms`);
    const onError = (err: Error) => log.error('netcash unrecorded-answer connection lost', { submissionId, error: err.message }, 'netcash');
    client.on('error', onError);
    const q = bounded(client);
    let unusable = false;
    let begun = false;
    try {
      await q.query('BEGIN');
      begun = true;
      await tightenSettleTimeouts(q);
      await actAsCaller(q, p);
      const metadata = {
        status: s.status, outcome: outcomeOf(s), batchReference: s.batchReference ?? '', settleToken,
        answer: JSON.stringify(s.netcashResponse ?? null),
      };
      await q.query(
        `INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes)
         VALUES ($1::UUID, $2, 'create', $3, $4::UUID, $5, jsonb_build_object('metadata', $6::JSONB))`,
        [p.companyId, p.userId, UNRECORDED_ANSWER_ENTITY, submissionId, s.batchReference, JSON.stringify(metadata)]);
      await q.query('COMMIT');
      return true;
    } catch (err) {
      if (begun) unusable = await rollbackFailed(client, 'netcash unrecorded answer');
      throw err;
    } finally {
      client.removeListener('error', onError);
      client.release(unusable);
    }
  } catch (err) {
    log.error('netcash answer could not be recorded durably either - only this log and the 500 carry it', {
      submissionId, status: s.status, batchReference: s.batchReference, answer: s.netcashResponse,
      error: err instanceof Error ? err.message : String(err),
    }, 'netcash');
    return false;
  }
}

/**
 * The newest recorded acceptance for this submission, in this company; null if none. Read in the caller's
 * transaction (RLS and the company predicate both scope it). Callers ask only for a 'pending' row, and a pending row
 * never carries its settle token (a settle that writes it moves the row out of 'pending'), so a record found for a
 * pending row is by construction one whose answer is not on the row.
 */
export async function unappliedAcceptedAnswer(companyId: string, submissionId: string): Promise<{ outcome: string; batchReference: string } | null> {
  const rows = (await sql`
    SELECT a.changes -> 'metadata' ->> 'outcome' AS outcome, a.changes -> 'metadata' ->> 'batchReference' AS batch_reference
    FROM audit_log a
    WHERE a.company_id = ${companyId}::UUID AND a.entity_type = ${UNRECORDED_ANSWER_ENTITY} AND a.entity_id = ${submissionId}::UUID
      AND a.changes -> 'metadata' ->> 'status' = 'submitted'
    ORDER BY a.created_at DESC
    LIMIT 1
  `) as DbRow[];
  if (!rows[0]) return null;
  return { outcome: String(rows[0].outcome ?? 'accepted'), batchReference: String(rows[0].batch_reference ?? '') };
}
