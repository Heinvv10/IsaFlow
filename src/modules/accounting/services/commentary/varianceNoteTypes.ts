/**
 * Budget variance notes (budgets P5 spec §3e): the shapes, the row key and the role rules. A note is a
 * `report_commentary` row with `report_kind = 'budget_variance'`, filed per (version, month) and per
 * account slice. Import-free on purpose: the Budget vs Actual page builds the same row key and asks the
 * same role questions, so nothing here may drag a server module into the browser bundle. The filing hash
 * (`node:crypto`) is server-only, in `reports/varianceParamsHash.ts`.
 */

export const VARIANCE_REPORT_KIND = 'budget_variance';
export const VARIANCE_SECTION_REF = 'account';

/** 'YYYY-MM', months 01-12. */
export const VARIANCE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The account slice a note explains: the account and the dimension ids of the view it was written on. */
export interface VarianceSlice {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export type VarianceNoteStatus = 'draft' | 'approved' | 'rejected';

/** What the list route answers per note. `draftText` is null for a reader outside the internal roles. */
export interface VarianceNote extends VarianceSlice {
  id: string;
  rowRef: string;
  status: VarianceNoteStatus;
  draftText: string | null;
  approvedText: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

/** `row_ref`: gl_account_id|cc1|cc2|bu, an absent dimension as ''. Ids lower-cased, so one slice has one key. */
export function varianceRowRef(s: VarianceSlice): string {
  const part = (v: string | null) => (v ?? '').toLowerCase();
  return [s.glAccountId.toLowerCase(), part(s.cc1Id), part(s.cc2Id), part(s.buId)].join('|');
}

/** The slice a stored `row_ref` names, or null when it is not one this module wrote (four parts, the first non-empty). */
export function parseVarianceRowRef(ref: string): VarianceSlice | null {
  const parts = ref.split('|');
  if (parts.length !== 4 || !parts[0]) return null;
  const [glAccountId, cc1, cc2, bu] = parts as [string, string, string, string];
  return { glAccountId, cc1Id: cc1 || null, cc2Id: cc2 || null, buId: bu || null };
}

/** Who may write a note: owner, admin, manager. */
export const VARIANCE_NOTE_WRITERS: readonly string[] = ['owner', 'admin', 'manager'];
/** Who may approve or reject one: owner, admin. */
export const VARIANCE_NOTE_APPROVERS: readonly string[] = ['owner', 'admin'];

/**
 * Whether `role` may write a note on `slice`. The slice is unused today: it is the hook for budget
 * holders (P5-6), who may write on their own slice only. That rule goes HERE, so the route, the service
 * and the page keep asking one question.
 */
export function mayWriteVarianceNote(role: unknown, slice?: VarianceSlice): boolean {
  void slice;
  return VARIANCE_NOTE_WRITERS.includes(String(role));
}

export function mayApproveVarianceNote(role: unknown): boolean {
  return VARIANCE_NOTE_APPROVERS.includes(String(role));
}
