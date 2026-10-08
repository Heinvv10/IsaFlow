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
 *
 * Approval — including the approver's own wording and the pack-wide budget — lives
 * in `commentaryApprove.ts`, re-exported here so callers keep one import.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { nextStatus } from './commentaryState';
import { buildDraftSentences, type CommentaryPackData } from './commentaryDraft';
import { canonicalParamsHash, type SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { toRow, currentRow, type CommentaryResult, type CommentaryRow } from './commentaryRow';

export type { CommentaryRow, CommentaryFailureCode, CommentaryResult } from './commentaryRow';
export { approveCommentary } from './commentaryApprove';

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

export async function rejectCommentary(companyId: string, id: string, userId: string): Promise<CommentaryResult> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
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
