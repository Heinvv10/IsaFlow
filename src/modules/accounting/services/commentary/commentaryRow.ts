/**
 * The commentary row shape, the result type the approval functions answer in,
 * and the two reads every state change starts from. Split out of
 * `commentaryService.ts` (the 300-line cap) so the approval can live beside its
 * budget without a cycle.
 */
import { sql, type DbRow } from '@/lib/neon';
import type { CommentaryStatus } from './commentaryState';

export interface CommentaryRow {
  id: string;
  sectionRef: string;
  rowRef: string;
  draftText: string;
  approvedText: string | null;
  status: CommentaryStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Set when a `replace` regeneration withdrew an approval. The approval
   *  columns beside these are the approval that was withdrawn, not a live one —
   *  `status` is what says whether the text is published. */
  withdrawnBy: string | null;
  withdrawnAt: string | null;
}

/** `not_found` is a 404; `empty_draft`, `invalid_text`, `text_too_long` and
 *  `commentary_budget_exceeded` are 400s; `invalid_state` is a 409. The route
 *  must not collapse them: an id that is not this company's is not the same
 *  answer as a draft that has already been approved. */
export type CommentaryFailureCode =
  | 'not_found' | 'empty_draft' | 'invalid_text' | 'text_too_long' | 'commentary_budget_exceeded' | 'invalid_state';
export type CommentaryResult =
  | { ok: true; row: CommentaryRow }
  | { ok: false; code: CommentaryFailureCode; reason: string };

export function toRow(r: DbRow): CommentaryRow {
  return {
    id: String(r.id),
    sectionRef: String(r.section_ref),
    rowRef: String(r.row_ref),
    draftText: String(r.draft_text),
    approvedText: r.approved_text === null || r.approved_text === undefined ? null : String(r.approved_text),
    status: String(r.status) as CommentaryStatus,
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    withdrawnBy: r.withdrawn_by ? String(r.withdrawn_by) : null,
    withdrawnAt: r.withdrawn_at ? new Date(r.withdrawn_at).toISOString() : null,
  };
}

export interface CurrentRow {
  status: CommentaryStatus; draftText: string; reportKind: string; paramsHash: string;
  periodStart: string; periodEnd: string;
}

export async function currentRow(companyId: string, id: string): Promise<CurrentRow | null> {
  const rows = (await sql`
    SELECT status, draft_text, report_kind, params_hash,
           to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end
    FROM report_commentary
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  return r
    ? {
      status: String(r.status) as CommentaryStatus, draftText: String(r.draft_text ?? ''),
      reportKind: String(r.report_kind), paramsHash: String(r.params_hash),
      periodStart: String(r.period_start), periodEnd: String(r.period_end),
    }
    : null;
}

