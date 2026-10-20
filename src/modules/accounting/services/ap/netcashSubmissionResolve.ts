/**
 * Releasing a Netcash claim that holds a batch (AP-01). A 'pending', 'unknown', 'submitted' or 'processing' submission
 * keeps its batch closed until an owner/admin has checked Netcash; this records what they found:
 *   'failed'    Netcash never got the batch, or rejected it - the claim leaves the unique index and the batch may be
 *               sent again. Allowed from all four statuses.
 *   'submitted' Netcash has the batch - the claim stays live and the batch stays closed. pending/unknown only.
 * The operator's attestation (a required note) is the only evidence: a status poll never is - status.ts reads free
 * text ("Processing - 0 errors"), and freeing a batch Netcash accepted pays it twice. A 'completed' or 'failed' row is
 * never resolved. Company-scoped, compare-and-set on the status that was read (a settle or a poll that moves the row
 * in between is never overwritten), and audit-logged in the same transaction.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { SEND_WINDOW_MS } from './netcashTimeouts';
import { NETCASH_SEND_LOCK_CLASS } from './netcashSendLock';

export type ResolveOutcome = 'failed' | 'submitted';

export type ResolveResult =
  | { kind: 'resolved'; previousStatus: string }
  | { kind: 'not_found' }
  | { kind: 'not_resolvable'; status: string }
  | { kind: 'changed'; from: string; to: string }
  | { kind: 'in_flight' };

export interface ResolveInput {
  companyId: string;
  submissionId: string;
  outcome: ResolveOutcome;
  note: string;
  userId: string;
  userEmail: string | null;
}

export async function resolveSubmission(input: ResolveInput): Promise<ResolveResult> {
  const { companyId, submissionId, outcome, note, userId, userEmail } = input;
  const found = (await sql`
    SELECT id, status, batch_reference, (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::FLOAT8 AS age_ms /* netcash_resolve_read */
    FROM netcash_submissions
    WHERE id = ${submissionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!found[0]) return { kind: 'not_found' };
  const previous = String(found[0].status);
  // pending/unknown: either outcome. submitted/processing (Netcash accepted it): 'failed' only, on the operator's word -
  // whatever the last poll said, which is a display hint and never consulted here.
  const heldOpen = previous === 'pending' || previous === 'unknown';
  const accepted = (previous === 'submitted' || previous === 'processing') && outcome === 'failed';
  if (!heldOpen && !accepted) return { kind: 'not_resolvable', status: previous };
  // A sender that is still alive holds the claim's send lock (netcashSendLock) from before its claim committed until
  // its settle has: refused at any age - a paused or stalled sender may still be accepted by Netcash. Held to the end
  // of this transaction, so no settle lands between this check and the write below.
  const free = (await sql`
    SELECT pg_try_advisory_xact_lock(${NETCASH_SEND_LOCK_CLASS}::INT4, hashtext(${submissionId}::UUID::TEXT)) AS free
  `) as DbRow[];
  if (free[0]?.free !== true) return { kind: 'in_flight' };
  // Second guard, kept for a sender whose CONNECTION died (taking the lock) while its process still sends: the send
  // is bounded by its 30 s timeout, so a pending claim younger than the send window may still be accepted. An unknown
  // claim is settled already and resolvable at any age.
  if (previous === 'pending' && Number(found[0].age_ms) < SEND_WINDOW_MS) return { kind: 'in_flight' };

  const resolution = JSON.stringify({ outcome, note, by: userEmail ?? userId, previousStatus: previous, at: new Date().toISOString() });
  const done = (await sql`
    UPDATE netcash_submissions
    SET status = ${outcome},
        netcash_response = COALESCE(netcash_response, '{}'::JSONB) || jsonb_build_object('resolved', ${resolution}::JSONB),
        submitted_at = CASE WHEN ${outcome} = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END
    WHERE id = ${submissionId}::UUID AND company_id = ${companyId}::UUID AND status = ${previous}
    RETURNING id
  `) as DbRow[];
  if (!done[0]) {
    const now = (await sql`
      SELECT status FROM netcash_submissions WHERE id = ${submissionId}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    return { kind: 'changed', from: previous, to: String(now[0]?.status ?? 'missing') };
  }

  await logAuditOrThrow({
    companyId, userId, userEmail: userEmail ?? undefined, action: 'update', entityType: 'netcash_submission',
    entityId: submissionId, entityRef: found[0].batch_reference ? String(found[0].batch_reference) : undefined,
    changes: {
      fields: [{ field: 'status', old: previous, new: outcome, label: 'Netcash submission status' }],
      metadata: { note, resolvedBy: userEmail ?? userId },
    },
  });
  return { kind: 'resolved', previousStatus: previous };
}
