/**
 * Releasing a Netcash claim that holds a batch (AP-01). A 'pending' or 'unknown' submission keeps its batch closed
 * until someone has checked Netcash; this records what they found:
 *   'failed'    Netcash never got the batch - the claim leaves the unique index and the batch may be sent again.
 *   'submitted' Netcash has the batch - the claim stays live and the batch stays closed.
 * Company-scoped, allowed only while the row is still pending/unknown (compare-and-set on the status that was read, so
 * a settle that lands in between is never overwritten), and audit-logged in the same transaction.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';

export type ResolveOutcome = 'failed' | 'submitted';

export type ResolveResult =
  | { kind: 'resolved'; previousStatus: string }
  | { kind: 'not_found' }
  | { kind: 'not_resolvable'; status: string };

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
    SELECT id, status, batch_reference /* netcash_resolve_read */
    FROM netcash_submissions
    WHERE id = ${submissionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!found[0]) return { kind: 'not_found' };
  const previous = String(found[0].status);
  if (previous !== 'pending' && previous !== 'unknown') return { kind: 'not_resolvable', status: previous };

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
    return { kind: 'not_resolvable', status: String(now[0]?.status ?? 'missing') };
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
