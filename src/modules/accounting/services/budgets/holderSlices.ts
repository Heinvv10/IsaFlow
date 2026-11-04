/**
 * Budget-holder slices (budgets P5-6, decision 9a): the shapes and the PURE rules both sides use.
 * The server's grid save and read model, and the client's grid, decide "is this cell inside one
 * of my slices, and may I change it now" with these functions. Nothing here reads the database:
 * the client bundle imports it (never import server-only code into it).
 *
 * A slice is one (CC1, CC2, BU) combination with at most one dimension set (954's one_dimension
 * checks): all NULL is the company-level slice. A holder row may also limit the accounts
 * (`glAccountIds`); null means every account of the slice. Migration 955 enforces the same rules
 * in the database (budget_month_amounts_slice_guard).
 */

export type SliceStatus = 'open' | 'submitted' | 'returned' | 'approved';

export const SLICE_STATUSES: readonly SliceStatus[] = ['open', 'submitted', 'returned', 'approved'];

export interface SliceKey {
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

/** One of the viewer's own holder rows, with its slice's review status (null: no review row). */
export interface HolderSlice extends SliceKey {
  glAccountIds: string[] | null;
  status: SliceStatus | null;
}

/** What the grid read model tells a holder (absent for owners, admins and non-holders). */
export interface HolderView {
  slices: HolderSlice[];
}

/** A submitted or approved slice is with its reviewer: only an owner or admin reviewing it may change it. */
export const isLockedStatus = (s: SliceStatus | null): boolean => s === 'submitted' || s === 'approved';

const lower = (v: string | null | undefined): string | null => (v == null ? null : v.toLowerCase());

export function sameSlice(a: SliceKey, b: SliceKey): boolean {
  return lower(a.cc1Id) === lower(b.cc1Id) && lower(a.cc2Id) === lower(b.cc2Id) && lower(a.buId) === lower(b.buId);
}

/** The holder slice a cell (account + dims) falls in, or null when it is outside all of them. */
export function sliceOf(slices: readonly HolderSlice[], cell: SliceKey & { glAccountId: string }): HolderSlice | null {
  const acct = cell.glAccountId.toLowerCase();
  return slices.find((s) => sameSlice(s, cell)
    && (s.glAccountIds === null || s.glAccountIds.some((a) => a.toLowerCase() === acct))) ?? null;
}

export const OUTSIDE_SLICE_REASON = 'Outside your budget slices';
export const SUBMITTED_SLICE_REASON = 'Submitted for review: read-only until it is returned';
export const APPROVED_SLICE_REASON = 'Approved by the reviewer: read-only';
export const NOT_DRAFT_REASON = 'Budget holders edit draft versions only';

/**
 * Why a holder may not change this cell, or null when they may: outside every slice, a version
 * that is not a draft, or a slice with its reviewer.
 */
export function holderReadReason(
  slices: readonly HolderSlice[], versionStatus: string, cell: SliceKey & { glAccountId: string },
): string | null {
  if (versionStatus !== 'draft') return NOT_DRAFT_REASON;
  const slice = sliceOf(slices, cell);
  if (!slice) return OUTSIDE_SLICE_REASON;
  if (slice.status === 'submitted') return SUBMITTED_SLICE_REASON;
  if (slice.status === 'approved') return APPROVED_SLICE_REASON;
  return null;
}

/** "CC1 OPS Operations", "BU …", or "Company level", from member labels by id. */
export function sliceLabel(key: SliceKey, labelOf: (id: string) => string | undefined): string {
  if (key.cc1Id) return `CC1 ${labelOf(key.cc1Id) ?? key.cc1Id}`;
  if (key.cc2Id) return `CC2 ${labelOf(key.cc2Id) ?? key.cc2Id}`;
  if (key.buId) return `BU ${labelOf(key.buId) ?? key.buId}`;
  return 'Company level';
}
