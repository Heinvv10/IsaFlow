/**
 * Approving a commentary row, with or without the approver's own wording. The
 * pack-wide budget it enforces is described in `commentaryLimits.ts`; which
 * packs it protects and the per-pack lock are in `commentaryBudget.ts`.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { nextStatus } from './commentaryState';
import { toRow, currentRow, type CommentaryResult } from './commentaryRow';
import {
  MAX_APPROVED_PACK_EMS, MAX_UNBUDGETED_CHARS, commentaryCost, editedTextProblem, normaliseEditedText,
} from './commentaryLimits';
import { budgetReason, lockAndReadPack, printsOnFixedPage } from './commentaryBudget';

/**
 * `editedText` absent: the machine draft is approved unchanged. Present: the
 * approver's own trimmed wording becomes `approved_text` and `draft_text` stays
 * the machine draft, so the row shows what was drafted against what a named
 * person signed.
 *
 * `reportKind` is the kind the CALLER serves: the pack routes leave it 'pack',
 * the variance-note service passes 'budget_variance'. A row of another kind
 * answers `not_found`, so a variance note cannot be approved through the pack
 * route (which does not apply the variance roles), nor a pack row through the
 * variance service.
 *
 * `expectedDraft`: the draft text the approver was SHOWN. When given, a row
 * whose draft is not exactly that text is `invalid_state` ("changed since you
 * opened it"), and the UPDATE repeats the comparison, so a writer re-drafting
 * between the approver's load and the click cannot get text approved that the
 * approver never saw. The variance-note service always passes it.
 */
const CHANGED = 'This note changed since you opened it, or is no longer a draft. Reload and review the new text.';

export async function approveCommentary(
  companyId: string, id: string, userId: string, editedText?: string, reportKind = 'pack', expectedDraft?: string,
): Promise<CommentaryResult> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  const edited = editedText === undefined ? undefined : normaliseEditedText(editedText);
  if (edited !== undefined) {
    const problem = editedTextProblem(edited);
    if (problem === 'empty') return { ok: false, code: 'empty_draft', reason: 'There is no visible text to approve.' };
    if (problem === 'invalid') {
      return { ok: false, code: 'invalid_text', reason: 'The text contains characters that cannot be stored.' };
    }
  }
  const row = await currentRow(companyId, id);
  if (!row || row.reportKind !== reportKind) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };
  // An approval is a person putting their name to a sentence. There is no
  // sentence here, so there is nothing to put a name to — and the 611 CHECK
  // would happily store the blank. (An edit supplies its own sentence.)
  if (edited === undefined && row.draftText.trim().length === 0) {
    return { ok: false, code: 'empty_draft', reason: 'There is no draft text to approve.' };
  }

  const t = nextStatus(row.status, 'approve');
  if (!t.ok) return { ok: false, code: 'invalid_state', reason: t.reason };
  if (expectedDraft !== undefined && row.draftText !== expectedDraft) return { ok: false, code: 'invalid_state', reason: CHANGED };

  if (!printsOnFixedPage(row)) {
    // No layout bounds this pack's text, only the request size: a generous ceiling.
    if (edited !== undefined && edited.length > MAX_UNBUDGETED_CHARS) {
      return {
        ok: false, code: 'text_too_long',
        reason: `Commentary is limited to ${MAX_UNBUDGETED_CHARS} characters.`,
      };
    }
  } else {
    const text = edited ?? row.draftText;
    // A hard ceiling before anything is costed: the cost model reads every character, and no page holds this many
    // (the budget is about 1,450 characters of prose), however narrow they are or however many marks they stack.
    if (text.length > MAX_UNBUDGETED_CHARS) {
      return { ok: false, code: 'text_too_long', reason: `Commentary is limited to ${MAX_UNBUDGETED_CHARS} characters.` };
    }
    // No pack can hold this much, so it needs no lock to be refused.
    if (commentaryCost([text]) > MAX_APPROVED_PACK_EMS) {
      return { ok: false, code: 'commentary_budget_exceeded', reason: budgetReason(0) };
    }
    // The page's own paragraph: every approved row in page order, this one at
    // its own position, costed as one text.
    const pack = await lockAndReadPack(companyId, id, row.reportKind, row.paramsHash);
    const others = commentaryCost(pack.filter((r) => r.id !== id).map((r) => r.text));
    // `lockAndReadPack` always returns this row (it reads `OR id = …` under the lock);
    // a missing one means it vanished mid-request, which is not a budget question.
    if (!pack.some((r) => r.id === id)) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };
    const page = pack.map((r) => (r.id === id ? text : r.text));
    if (commentaryCost(page) > MAX_APPROVED_PACK_EMS) {
      return { ok: false, code: 'commentary_budget_exceeded', reason: budgetReason(MAX_APPROVED_PACK_EMS - others) };
    }
  }

  // One statement: status, text, approver and timestamp together, so the CHECK
  // constraint never sees a partially approved row. `status = 'draft'` and the
  // non-empty test are in the WHERE, not only in the branches above: two
  // approvals racing must not both write, and the second finds no row. The
  // plain path ALSO compares the draft it costed: a regenerate committing
  // between the read above and this write must not publish text nobody costed.
  const rows = (edited === undefined ? await sql`
    UPDATE report_commentary
    SET status = 'approved', approved_text = draft_text, approved_by = ${userId},
        approved_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND report_kind = ${reportKind}
      AND status = 'draft' AND btrim(draft_text) <> '' AND draft_text = ${row.draftText}
    RETURNING *
  ` : expectedDraft !== undefined ? await sql`
    UPDATE report_commentary
    SET status = 'approved', approved_text = ${edited}, approved_by = ${userId},
        approved_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND report_kind = ${reportKind}
      AND status = 'draft' AND btrim(${edited}) <> '' AND draft_text = ${expectedDraft}
    RETURNING *
  ` : await sql`
    UPDATE report_commentary
    SET status = 'approved', approved_text = ${edited}, approved_by = ${userId},
        approved_at = NOW(), updated_at = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND report_kind = ${reportKind}
      AND status = 'draft' AND btrim(${edited}) <> ''
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) {
    return {
      ok: false, code: 'invalid_state',
      reason: expectedDraft !== undefined ? CHANGED : edited === undefined
        ? 'This commentary is no longer a draft, or its draft text changed. Reload and review the new text.'
        : 'This commentary is no longer a draft.',
    };
  }

  log.info('Commentary approved', { companyId, userId, commentaryId: id, edited: edited !== undefined }, 'commentary');
  return { ok: true, row: toRow(rows[0]) };
}
