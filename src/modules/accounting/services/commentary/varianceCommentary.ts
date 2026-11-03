/**
 * Budget variance notes (budgets P5 spec §3e): a person's note on one Budget vs Actual row for one
 * (version, month), held as a DRAFT until an owner or admin approves it. Stored in `report_commentary`
 * with `report_kind = 'budget_variance'`; no pack, share or list reader selects that kind, and
 * `printsOnFixedPage` charges it no page-4 budget.
 *
 * Roles (`varianceNoteTypes.ts`): owner/admin/manager write; owner/admin approve and reject. The role is
 * checked HERE, before anything is read, so no caller can skip it; the generic commentary routes cannot
 * reach these rows at all (`approveCommentary` / `rejectCommentary` serve one kind per caller).
 *
 * Every statement carries `company_id`; every id in a write is checked to be the company's
 * (`varianceNoteScope.ts`) before the write.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isValidUUID } from '@/lib/validation';
import { varianceMonthBounds, varianceParamsHash } from '@/modules/accounting/services/reports/varianceParamsHash';
import { canReadSharingSurface } from '@/modules/accounting/services/reports/sharingAccess';
import { approveCommentary } from './commentaryApprove';
import { rejectCommentary } from './commentaryService';
import { MAX_UNBUDGETED_CHARS, editedTextProblem, normaliseEditedText } from './commentaryLimits';
import type { CommentaryFailureCode, CommentaryRow } from './commentaryRow';
import { checkSlice, checkVersionMonth } from './varianceNoteScope';
import {
  VARIANCE_REPORT_KIND, VARIANCE_SECTION_REF, mayApproveVarianceNote, mayWriteVarianceNote, parseVarianceRowRef,
  varianceRowRef, type VarianceNote, type VarianceNoteStatus, type VarianceSlice,
} from './varianceNoteTypes';

export type VarianceFailureCode = CommentaryFailureCode | 'forbidden' | 'bad_request';
type Failure = { ok: false; code: VarianceFailureCode; reason: string };
export type VarianceResult = { ok: true; note: VarianceNote } | Failure;
export type VarianceListResult = { ok: true; notes: VarianceNote[] } | Failure;

/** The caller: the session user and their role in the session company. */
export interface VarianceActor { userId: string; role: unknown }

export interface SaveVarianceNoteInput extends VarianceSlice {
  versionId: string;
  /** 'YYYY-MM'. */
  month: string;
  text: string;
}

const forbidden = (reason: string): Failure => ({ ok: false, code: 'forbidden', reason });

function noteOf(r: {
  id: string; rowRef: string; status: string; draftText: string | null; approvedText: string | null;
  approvedBy: string | null; approvedAt: string | null;
}, internal: boolean): VarianceNote | null {
  const slice = parseVarianceRowRef(r.rowRef);
  if (!slice) return null;
  return {
    ...slice, id: r.id, rowRef: r.rowRef, status: r.status as VarianceNoteStatus,
    // A reader outside the internal roles sees the approved text and nothing a person has not signed.
    draftText: internal ? r.draftText : null,
    approvedText: r.status === 'approved' ? r.approvedText : null,
    approvedBy: r.status === 'approved' ? r.approvedBy : null,
    approvedAt: r.status === 'approved' ? r.approvedAt : null,
  };
}

function noteOfDb(r: DbRow, internal: boolean): VarianceNote | null {
  return noteOf({
    id: String(r.id), rowRef: String(r.row_ref), status: String(r.status), draftText: String(r.draft_text ?? ''),
    approvedText: r.approved_text == null ? null : String(r.approved_text),
    approvedBy: r.approved_by == null ? null : String(r.approved_by),
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
  }, internal);
}

const noteOfRow = (r: CommentaryRow): VarianceNote | null => noteOf(r, true);

/**
 * The notes on one (version, month). Approved notes for every member; drafts and rejected notes for the
 * internal roles only (owner/admin/manager, `canReadSharingSurface`): a draft is a sentence about the
 * company's numbers nobody has signed.
 */
export async function listVarianceNotes(
  companyId: string, role: unknown, versionId: string, month: string,
): Promise<VarianceListResult> {
  const scope = await checkVersionMonth(companyId, versionId, month);
  if (scope) return scope;
  const internal = canReadSharingSurface(role);
  const rows = (await sql`
    SELECT id, row_ref, status, draft_text, approved_text, approved_by, approved_at
    FROM report_commentary
    WHERE company_id = ${companyId}::UUID
      AND report_kind = ${VARIANCE_REPORT_KIND}
      AND params_hash = ${varianceParamsHash(versionId, month)}
      AND section_ref = ${VARIANCE_SECTION_REF}
      AND (status = 'approved' OR ${internal}::BOOLEAN)
    ORDER BY row_ref
  `) as DbRow[];
  const notes = rows.map((r) => noteOfDb(r, internal)).filter((n): n is VarianceNote => n !== null);
  return { ok: true, notes };
}

/**
 * Writes the caller's text as the slice's DRAFT (`generated_by = 'human:<uid>'`), creating the row or
 * re-drafting it. A rejected note is revived (a person typed new text). An APPROVED note is re-drafted
 * only by an approver, and its approval is then stamped withdrawn (`withdrawn_by/at`; the approval
 * columns survive, as for a pack regeneration); a manager gets `invalid_state`. The `DO UPDATE ... WHERE`
 * repeats that rule on the row's state at write time, so an approval landing in between is not undone.
 */
export async function saveVarianceNote(
  companyId: string, actor: VarianceActor, input: SaveVarianceNoteInput,
): Promise<VarianceResult> {
  const slice: VarianceSlice = { glAccountId: input.glAccountId, cc1Id: input.cc1Id, cc2Id: input.cc2Id, buId: input.buId };
  if (!mayWriteVarianceNote(actor.role, slice)) return forbidden('Only an owner, admin or manager can write a variance note.');
  const text = normaliseEditedText(input.text);
  const problem = editedTextProblem(text);
  if (problem === 'empty') return { ok: false, code: 'empty_draft', reason: 'There is no visible text to save.' };
  if (problem === 'invalid') return { ok: false, code: 'invalid_text', reason: 'The text contains characters that cannot be stored.' };
  if (text.length > MAX_UNBUDGETED_CHARS) {
    return { ok: false, code: 'text_too_long', reason: `A variance note is limited to ${MAX_UNBUDGETED_CHARS} characters.` };
  }
  const scope = (await checkVersionMonth(companyId, input.versionId, input.month)) ?? (await checkSlice(companyId, slice));
  if (scope) return scope;

  const { start, end } = varianceMonthBounds(input.month);
  const mayWithdraw = mayApproveVarianceNote(actor.role);
  const rows = (await sql`
    INSERT INTO report_commentary
      (company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref, draft_text, status, generated_by)
    VALUES
      (${companyId}::UUID, ${VARIANCE_REPORT_KIND}, ${varianceParamsHash(input.versionId, input.month)},
       ${start}::DATE, ${end}::DATE, ${VARIANCE_SECTION_REF}, ${varianceRowRef(slice)}, ${text}, 'draft',
       ${`human:${actor.userId}`})
    ON CONFLICT (company_id, report_kind, params_hash, section_ref, row_ref)
    DO UPDATE SET
      draft_text = EXCLUDED.draft_text,
      status = 'draft',
      withdrawn_by = CASE WHEN report_commentary.status = 'approved' THEN ${actor.userId} ELSE report_commentary.withdrawn_by END,
      withdrawn_at = CASE WHEN report_commentary.status = 'approved' THEN NOW() ELSE report_commentary.withdrawn_at END,
      generated_by = EXCLUDED.generated_by,
      updated_at = NOW()
    WHERE report_commentary.status <> 'approved' OR ${mayWithdraw}::BOOLEAN
    RETURNING id, row_ref, status, draft_text, approved_text, approved_by, approved_at
  `) as DbRow[];
  if (!rows[0]) {
    return { ok: false, code: 'invalid_state', reason: 'This note is approved. Only an owner or admin can change an approved note.' };
  }
  const note = noteOfDb(rows[0], true);
  if (!note) throw new Error('variance note written with a row_ref it cannot read back');
  log.info('Variance note saved', { companyId, userId: actor.userId, commentaryId: note.id }, 'commentary');
  return { ok: true, note };
}

/**
 * Owner/admin only. The existing approval (`approveCommentary`), restricted to variance rows.
 * `seenDraft` is the draft text the approver was shown: a note re-drafted since is `invalid_state` (409)
 * and nothing is approved, so nobody signs a sentence they never read.
 */
export async function approveVarianceNote(
  companyId: string, actor: VarianceActor, id: string, seenDraft: string, editedText?: string,
): Promise<VarianceResult> {
  if (!mayApproveVarianceNote(actor.role)) return forbidden('Only an owner or admin can approve a variance note.');
  if (!isValidUUID(id)) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };
  const r = await approveCommentary(companyId, id, actor.userId, editedText, VARIANCE_REPORT_KIND, seenDraft);
  if (!r.ok) return r;
  const note = noteOfRow(r.row);
  if (!note) throw new Error('approved a variance note whose row_ref it cannot read');
  return { ok: true, note };
}

/** Owner/admin only. The existing rejection (`rejectCommentary`), restricted to variance rows; `seenDraft` as for approve. */
export async function rejectVarianceNote(
  companyId: string, actor: VarianceActor, id: string, seenDraft: string,
): Promise<VarianceResult> {
  if (!mayApproveVarianceNote(actor.role)) return forbidden('Only an owner or admin can reject a variance note.');
  if (!isValidUUID(id)) return { ok: false, code: 'not_found', reason: 'Commentary not found.' };
  const r = await rejectCommentary(companyId, id, actor.userId, VARIANCE_REPORT_KIND, seenDraft);
  if (!r.ok) return r;
  const note = noteOfRow(r.row);
  if (!note) throw new Error('rejected a variance note whose row_ref it cannot read');
  return { ok: true, note };
}

/** One approved note for a pack: its month and slice, and the text a named person approved. */
export interface ApprovedVarianceNote extends VarianceSlice { month: string; text: string }

/**
 * The APPROVED notes of `versionId` for `months` ('YYYY-MM'), for the management pack's budget_variance
 * section. Approved status AND approved text, never a draft and never a fallback to it.
 */
export async function listApprovedVarianceNotes(
  companyId: string, versionId: string, months: readonly string[],
): Promise<ApprovedVarianceNote[]> {
  if (!isValidUUID(versionId) || months.length === 0) return [];
  const byHash = new Map(months.map((m) => [varianceParamsHash(versionId, m), m]));
  const rows = (await sql`
    SELECT params_hash, row_ref, approved_text
    FROM report_commentary
    WHERE company_id = ${companyId}::UUID
      AND report_kind = ${VARIANCE_REPORT_KIND}
      AND params_hash = ANY(${[...byHash.keys()]}::TEXT[])
      AND section_ref = ${VARIANCE_SECTION_REF}
      AND status = 'approved'
      AND approved_text IS NOT NULL
    ORDER BY period_start, row_ref
  `) as DbRow[];
  const out: ApprovedVarianceNote[] = [];
  for (const r of rows) {
    const slice = parseVarianceRowRef(String(r.row_ref));
    const month = byHash.get(String(r.params_hash));
    const text = String(r.approved_text).trim();
    if (slice && month && text !== '') out.push({ ...slice, month, text });
  }
  return out;
}
