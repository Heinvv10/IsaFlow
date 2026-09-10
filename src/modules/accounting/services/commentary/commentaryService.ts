/**
 * Persistence and approval for commentary. Every function is company-scoped;
 * the company_id predicate is on every statement, including the UPDATEs, so a
 * commentary id from another tenant matches zero rows rather than being
 * approved by someone who is not a member of its company.
 *
 * `nextStatus` decides the status and nothing else. The rest of the rule lives
 * here: an empty draft is never approvable, the approver is the authenticated
 * caller and the timestamp is the database's NOW(), and approved_text,
 * approved_by and approved_at are written together in one statement so the 611
 * CHECK constraint can never observe a half-approved row.
 */
import { sql, type DbRow } from '@/lib/neon';
import { requestImpersonator } from '@/modules/accounting/services/controls/independentReview';
import { log } from '@/lib/logger';
import { nextStatus, type CommentaryStatus } from './commentaryState';
import { buildDraftSentences, type CommentaryPackData } from './commentaryDraft';
import { canonicalParamsHash, type SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

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

/** `not_found` is a 404, `empty_draft` a 400, `invalid_state` a 409. The route
 *  must not collapse them: an id that is not this company's is not the same
 *  answer as a draft that has already been approved. */
export type CommentaryFailureCode = 'not_found' | 'empty_draft' | 'invalid_state';
export type CommentaryResult =
  | { ok: true; row: CommentaryRow }
  | { ok: false; code: CommentaryFailureCode; reason: string };

function toRow(r: DbRow): CommentaryRow {
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

export async function listCommentary(companyId: string, params: SharePackParams): Promise<CommentaryRow[]> {
  const rows = (await sql`
    SELECT * FROM report_commentary
    WHERE company_id = ${companyId}::uuid
      AND report_kind = 'pack'
      AND params_hash = ${canonicalParamsHash(params)}
    ORDER BY section_ref, row_ref
  `) as DbRow[];
  return rows.map(toRow);
}

/** Upserts one draft per sentence. `replace` is the ONLY way a row a person
 *  already ruled on is re-drafted: an approved row has its approval withdrawn,
 *  a rejected one is revived. Without it both are left exactly as they stand
 *  and reported in `skipped` — a discarded sentence does not come back merely
 *  because somebody pressed Generate again. */
export async function generateDrafts(input: {
  companyId: string; userId: string; params: SharePackParams; data: CommentaryPackData; replace?: boolean;
}): Promise<{ written: number; skipped: string[] }> {
  const hash = canonicalParamsHash(input.params);
  const existing = new Map(
    (await listCommentary(input.companyId, input.params)).map(r => [`${r.sectionRef}:${r.rowRef}`, r.status]),
  );

  let written = 0;
  const skipped: string[] = [];

  // The one flag both overwrite cases share, and the one the SQL guard reads.
  const overwrite = input.replace === true;

  for (const s of buildDraftSentences(input.data)) {
    const key = `${s.sectionRef}:${s.rowRef}`;
    const current = existing.get(key) ?? null;
    // `nextStatus` permits rejected -> draft, because that transition is legal.
    // Whether it happens without anybody asking for it is this function's call,
    // and the answer is no: a rejection is a person's decision, and undoing it
    // takes the same explicit intent as withdrawing an approval.
    if (current === 'rejected' && !overwrite) { skipped.push(key); continue; }
    const t = nextStatus(current, current === 'approved' && overwrite ? 'regenerate' : 'generate');
    if (!t.ok) { skipped.push(key); continue; }

    // The DO UPDATE ... WHERE repeats the decision at the write. Between the
    // read above and this statement another session can approve or reject the
    // row; without the guard this upsert would quietly demote that approval, or
    // undo that rejection, with nobody having asked for either.
    //
    // A withdrawal is STAMPED, not erased. approved_text, approved_by and
    // approved_at survive it, so the row still says who put their name to that
    // sentence, and withdrawn_by/withdrawn_at say who took it back and when
    // (migration 612). Nothing leaks by keeping them: the published query
    // filters on status = 'approved' and this row is now a draft.
    //
    // The stamp is written on the row's ACTUAL state at write time rather than
    // on the read-time flag, so a row approved inside the read-to-write window
    // is recorded as withdrawn by whoever's regeneration actually did it.
    const rows = (await sql`
      INSERT INTO report_commentary
        (company_id, report_kind, params_hash, period_start, period_end,
         section_ref, row_ref, draft_text, status, generated_by)
      VALUES
        (${input.companyId}::uuid, 'pack', ${hash}, ${input.params.from}::date, ${input.params.to}::date,
         ${s.sectionRef}, ${s.rowRef}, ${s.text}, 'draft', ${input.userId})
      ON CONFLICT (company_id, report_kind, params_hash, section_ref, row_ref)
      DO UPDATE SET
        draft_text = EXCLUDED.draft_text,
        status = 'draft',
        withdrawn_by = CASE WHEN report_commentary.status = 'approved' THEN ${input.userId} ELSE report_commentary.withdrawn_by END,
        withdrawn_at = CASE WHEN report_commentary.status = 'approved' THEN NOW() ELSE report_commentary.withdrawn_at END,
        generated_by = EXCLUDED.generated_by,
        updated_at = NOW()
      WHERE report_commentary.status = 'draft' OR ${overwrite}::boolean
      RETURNING id
    `) as DbRow[];

    if (!rows[0]) { skipped.push(key); continue; }
    written += 1;
    if (t.withdrawsApproval) {
      log.info('Commentary approval withdrawn by regeneration', {
        companyId: input.companyId, userId: input.userId, sectionRef: s.sectionRef, rowRef: s.rowRef,
      }, 'commentary');
    }
  }

  log.info('Commentary drafts generated', {
    companyId: input.companyId, userId: input.userId, written, skipped: skipped.length,
  }, 'commentary');
  return { written, skipped };
}

async function currentRow(
  companyId: string, id: string,
): Promise<{ status: CommentaryStatus; draftText: string } | null> {
  const rows = (await sql`
    SELECT status, draft_text FROM report_commentary
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  return r ? { status: String(r.status) as CommentaryStatus, draftText: String(r.draft_text ?? '') } : null;
}

/**
 * Sign-off is not blocked under impersonation - an admin helping a client finish
 * a report is legitimate and the text carries no ledger effect - but the record
 * must be truthful: `approved_by` stays the member whose session signed, and
 * `approved_by_impersonator` names the administrator who drove it (or the
 * unverified marker when the impersonation state could not be established).
 */
export async function approveCommentary(companyId: string, id: string, userId: string): Promise<CommentaryResult> {
  const row = await currentRow(companyId, id);
  if (!row) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };
  // An approval is a person putting their name to a sentence. There is no
  // sentence here, so there is nothing to put a name to — and the 611 CHECK
  // would happily store the blank.
  if (row.draftText.trim().length === 0) {
    return { ok: false, code: 'empty_draft', reason: 'There is no draft text to approve.' };
  }

  const t = nextStatus(row.status, 'approve');
  if (!t.ok) return { ok: false, code: 'invalid_state', reason: t.reason };

  // One statement: status, text, approver and timestamp together, so the CHECK
  // constraint never sees a partially approved row. `status = 'draft'` and the
  // non-empty test are in the WHERE, not only in the branches above: two
  // approvals racing must not both write, and the second finds no row.
  const rows = (await sql`
    UPDATE report_commentary
    SET status = 'approved', approved_text = draft_text, approved_by = ${userId},
        approved_by_impersonator = ${requestImpersonator()}, approved_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      AND status = 'draft' AND btrim(draft_text) <> ''
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) return { ok: false, code: 'invalid_state', reason: 'This commentary is no longer a draft.' };

  log.info('Commentary approved', { companyId, userId, commentaryId: id }, 'commentary');
  return { ok: true, row: toRow(rows[0]) };
}

export async function rejectCommentary(companyId: string, id: string, userId: string): Promise<CommentaryResult> {
  const row = await currentRow(companyId, id);
  if (!row) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };

  const t = nextStatus(row.status, 'reject');
  if (!t.ok) return { ok: false, code: 'invalid_state', reason: t.reason };

  const rows = (await sql`
    UPDATE report_commentary
    SET status = 'rejected', updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND status = 'draft'
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) return { ok: false, code: 'invalid_state', reason: 'This commentary is no longer a draft.' };

  log.info('Commentary rejected', { companyId, userId, commentaryId: id }, 'commentary');
  return { ok: true, row: toRow(rows[0]) };
}
