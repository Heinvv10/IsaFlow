/**
 * A Netcash answer the settle could not record, kept durably (AP-01 round 14). When both bounded settle attempts fail,
 * the answer is written to audit_log in its own short transaction - a table that needs no lock on the submission row
 * (which is what stalled the settle) and survives a restart, unlike the late settler's in-process guard. resolve then
 * refuses to FREE a still-pending submission whose recorded answer is an acceptance, in any process (once a settle
 * writes the answer - its token on the row - the row is no longer pending).
 * No migration: audit_log is append-only (880) and only inserted into. If this insert fails too, the answer is spooled
 * to local disk (netcashAnswerSpool, residual 3a), which resolve reads as well; only if the spool fails too do the 500
 * body and the log.error alone carry it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { actAsCaller, bounded, tightenSettleTimeouts, type ClaimPrincipal, type ClaimSettlement, type Queryable } from './netcashClaimSettle';
import { spoolAnswer, spooledAcceptedAnswer, type AnswerRecord } from './netcashAnswerSpool';
import { connectWithin } from './netcashSendCapacity';
import { UNRECORDED_ANSWER_BUDGET_MS, UNRECORDED_ANSWER_CHECKOUT_MS } from './netcashTimeouts';
import { jsonSafe, safeReference } from './netcashAnswerSafety';

export const UNRECORDED_ANSWER_ENTITY = 'netcash_unrecorded_answer';

/** Netcash's word for the answer ('accepted' / 'rejected' / 'unknown'), else the status it settles to. */
function outcomeOf(s: ClaimSettlement): string {
  const o = (s.netcashResponse as { outcome?: unknown } | null)?.outcome;
  return typeof o === 'string' ? o : s.status;
}

/** What the audit record carries for this answer (the metadata made jsonb-safe; the reference only as text that fits). */
function recordOf(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement, settleToken: string): AnswerRecord {
  const sub = (p.claims as { sub?: unknown }).sub;
  return {
    companyId: p.companyId, userId: p.userId, sub: typeof sub === 'string' ? sub : null, submissionId, entityRef: safeReference(s.batchReference),
    // Round 15: the reference only in metadata (JSONB, made safe); entity_ref (varchar(100)) only when it fits as is, so the
    // record cannot fail on the answer's own content.
    metadata: jsonSafe({
      status: s.status, outcome: outcomeOf(s), batchReference: s.batchReference == null ? '' : String(s.batchReference), settleToken,
      answer: JSON.stringify(s.netcashResponse ?? null),
    }),
  };
}

/**
 * Run `fn` in one short transaction on its own bounded connection (checkout UNRECORDED_ANSWER_CHECKOUT_MS, the attempt
 * UNRECORDED_ANSWER_BUDGET_MS in all, nothing sent past it), as app_user with the principal's claims and company.
 */
export async function inAnswerTx<T>(p: ClaimPrincipal, submissionId: string, label: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await connectWithin(getPool(), UNRECORDED_ANSWER_CHECKOUT_MS);
  if (!client) throw new Error(`no connection within ${UNRECORDED_ANSWER_CHECKOUT_MS} ms`);
  const onError = (err: Error) => log.error('netcash unrecorded-answer connection lost', { submissionId, error: err.message }, 'netcash');
  client.on('error', onError);
  const q = bounded(client, UNRECORDED_ANSWER_BUDGET_MS);
  let unusable = false;
  let begun = false;
  try {
    await q.query('BEGIN');
    begun = true;
    await tightenSettleTimeouts(q);
    await actAsCaller(q, p);
    const out = await fn(q);
    await q.query('COMMIT');
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, label);
    throw err;
  } finally {
    client.removeListener('error', onError);
    client.release(unusable);
  }
}

/**
 * A plain INSERT with exactly logAuditOrThrow's columns (core/auditTrailService; no hash chain, no trigger - pinned by
 * netcashUnrecordedAnswerColumns.test.ts), but on this record's OWN connection: logAuditOrThrow writes on the request's
 * `sql` transaction, which the 500 this record precedes rolls back.
 */
export async function insertAnswerRecord(q: Queryable, rec: AnswerRecord): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (
       company_id, user_id, user_email, action,
       entity_type, entity_id, entity_ref,
       changes, ip_address, user_agent, session_id
     ) VALUES ($1::UUID, $2, NULL, 'create', $3, $4::UUID, $5, jsonb_build_object('metadata', $6::JSONB), NULL, NULL, NULL)`,
    [rec.companyId, rec.userId, UNRECORDED_ANSWER_ENTITY, rec.submissionId, rec.entityRef, JSON.stringify(rec.metadata)]);
}

/**
 * Write the answer to audit_log, committed on its own bounded connection. true when written; never throws. When that
 * fails too (the database is that unwell) the answer goes to the local spool (netcashAnswerSpool, residual 3a): resolve
 * reads it there, and the replay moves it into audit_log later. Still false then - audit_log does not hold it yet.
 */
export async function recordUnrecordedAnswer(p: ClaimPrincipal, submissionId: string, s: ClaimSettlement,
  settleToken: string): Promise<boolean> {
  const rec = recordOf(p, submissionId, s, settleToken);
  try {
    await inAnswerTx(p, submissionId, 'netcash unrecorded answer', (q) => insertAnswerRecord(q, rec));
    return true;
  } catch (err) {
    log.error('netcash answer could not be recorded durably in audit_log - spooling it to local disk', {
      submissionId, status: s.status, batchReference: s.batchReference, answer: s.netcashResponse,
      error: err instanceof Error ? err.message : String(err),
    }, 'netcash');
    await spoolAnswer(rec);
    return false;
  }
}

/**
 * The newest recorded acceptance for this submission, in this company, in audit_log or the local spool; null if none. Read in the caller's
 * transaction (RLS and the company predicate both scope it). Callers ask only for a 'pending' row, and a pending row
 * never carries its settle token (a settle that writes it moves the row out of 'pending'), so a record found for a
 * pending row is by construction one whose answer is not on the row.
 */
export async function unappliedAcceptedAnswer(companyId: string, submissionId: string): Promise<{ outcome: string; batchReference: string; file?: string } | null> {
  // The spool FIRST, then audit_log (breaker REPRO-1): a replay in another process commits the audit_log row and only THEN
  // moves the file out of the spool's directory, so a spool read that finds nothing (the file moved to replayed/ already)
  // is followed by an audit_log read that sees the row. Reading audit_log first left a gap where both were empty. The
  // spool lookup itself reads the directory, then quarantine/ (a move is dir -> quarantine, same order).
  const spooled = await spooledAcceptedAnswer(companyId, submissionId);
  const rows = (await sql`
    SELECT a.changes -> 'metadata' ->> 'outcome' AS outcome, a.changes -> 'metadata' ->> 'batchReference' AS batch_reference
    FROM audit_log a
    WHERE a.company_id = ${companyId}::UUID AND a.entity_type = ${UNRECORDED_ANSWER_ENTITY} AND a.entity_id = ${submissionId}::UUID
      AND a.changes -> 'metadata' ->> 'status' = 'submitted'
    ORDER BY a.created_at DESC
    LIMIT 1
  `) as DbRow[];
  if (rows[0]) return { outcome: String(rows[0].outcome ?? 'accepted'), batchReference: String(rows[0].batch_reference ?? '') };
  // Residual 3a: not in audit_log (yet) - an answer spooled to local disk counts the same way, company-scoped.
  return spooled;
}
