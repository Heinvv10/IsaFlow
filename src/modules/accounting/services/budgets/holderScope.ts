/**
 * Who is writing or reading a version, as the budget-holder rules see it (budgets P5-6, decision
 * 9a), and the grid save's API-level enforcement of those rules. Migration 955's trigger
 * (budget_month_amounts_slice_guard) is the backstop for every writer; this is the check that
 * answers a typed 403/409 naming the cell before anything is written.
 *
 * - An owner or admin is a reviewer: they see every slice, and their grid save takes the reviewer
 *   path (`beginSliceReview`), so it may change a submitted or approved slice.
 * - A holder (any other member with a budget_holders row in the version) writes only inside their
 *   slices, only on a draft version, and never a slice with its reviewer.
 * - Anyone else who may write (a manager who holds nothing in the version) writes as before, except
 *   into a submitted or approved slice.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BudgetVersionError } from './budgetVersionTypes';
import { isLockedStatus, sameSlice, sliceOf, type HolderSlice, type SliceKey, type SliceStatus } from './holderSlices';
import { parseKey } from './grid/cellKey';
import type { DriverWriteGuard } from './drivers/driverRecomputeService';
import type { Cell, RowKey } from './drivers/driverTypes';

export interface HolderScope {
  role: string | null;
  /** An owner or admin of the company. */
  reviewer: boolean;
  /** The user's own holder rows in the version (empty for a reviewer: they are not limited). */
  slices: HolderSlice[];
  /** Every slice review of the version. */
  reviews: Array<SliceKey & { status: SliceStatus }>;
}

const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function loadHolderScope(companyId: string, versionId: string, userId: string): Promise<HolderScope> {
  const rows = (await sql`
    SELECT 'role' AS kind, cu.role AS status, NULL::UUID AS cc1_id, NULL::UUID AS cc2_id, NULL::UUID AS bu_id, NULL::TEXT[] AS accounts
      FROM company_users cu WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${userId}
    UNION ALL
    SELECT 'holder', r.status, h.cc1_id, h.cc2_id, h.bu_id, h.gl_account_ids::TEXT[]
      FROM budget_holders h
      LEFT JOIN budget_slice_reviews r ON r.company_id = h.company_id AND r.version_id = h.version_id
       AND r.cc1_id IS NOT DISTINCT FROM h.cc1_id AND r.cc2_id IS NOT DISTINCT FROM h.cc2_id AND r.bu_id IS NOT DISTINCT FROM h.bu_id
     WHERE h.company_id = ${companyId}::UUID AND h.version_id = ${versionId}::UUID AND h.user_id = ${userId}
    UNION ALL
    SELECT 'review', r.status, r.cc1_id, r.cc2_id, r.bu_id, NULL
      FROM budget_slice_reviews r WHERE r.company_id = ${companyId}::UUID AND r.version_id = ${versionId}::UUID
  `) as DbRow[];
  const role = rows.find((r) => r.kind === 'role');
  const reviewer = role?.status === 'owner' || role?.status === 'admin';
  const key = (r: DbRow): SliceKey => ({ cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id) });
  return {
    role: role ? String(role.status) : null,
    reviewer,
    slices: reviewer ? [] : rows.filter((r) => r.kind === 'holder').map((r) => ({
      ...key(r),
      glAccountIds: Array.isArray(r.accounts) ? (r.accounts as unknown[]).map(String) : null,
      status: r.status == null ? null : (String(r.status) as SliceStatus),
    })),
    reviews: rows.filter((r) => r.kind === 'review').map((r) => ({ ...key(r), status: String(r.status) as SliceStatus })),
  };
}

/** A holder: limited to their slices (an owner or admin never is). */
export const isHolder = (scope: HolderScope): boolean => !scope.reviewer && scope.slices.length > 0;

export interface SliceCell extends SliceKey { glAccountId: string; month: string }

/**
 * The grid save's check, before any write: a holder's cells must all be inside their slices on a
 * draft version (403 BUDGET_SLICE_FORBIDDEN), and no one but a reviewer changes a cell of a
 * submitted or approved slice (409 BUDGET_SLICE_LOCKED). The message names the first cell refused.
 */
export function assertSliceWrites(
  scope: HolderScope, versionStatus: string, cells: readonly SliceCell[], label: (accountId: string) => string,
): void {
  if (scope.reviewer) return;
  const name = (c: SliceCell) => `account ${label(c.glAccountId)} month ${c.month}`;
  if (isHolder(scope)) {
    if (versionStatus !== 'draft') {
      throw new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'Budget holders edit draft versions only; this version is ' + versionStatus);
    }
    const outside = cells.find((c) => sliceOf(scope.slices, c) === null);
    if (outside) throw new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', `You can change only your own budget slices: ${name(outside)} is outside them`);
  }
  if (versionStatus !== 'draft') return;
  const locked = cells.find((c) => isLockedStatus(scope.reviews.find((r) => sameSlice(r, c))?.status ?? null));
  if (locked) {
    const status = scope.reviews.find((r) => sameSlice(r, locked))!.status;
    throw new BudgetVersionError('BUDGET_SLICE_LOCKED', `This budget slice is ${status} for review (${name(locked)}); only the reviewer can change it`);
  }
}

/**
 * The reviewer path (migration 955): an owner's or admin's grid save opens ONLY the submitted or
 * approved slices its own cells are in (budget_slice_review_begin_slice, one per slice), so the
 * trigger lets them change those, and nothing else locked (r4: a driver recompute never writes into
 * a locked slice, see driverSliceGuard).
 */
export async function beginSliceReview(
  companyId: string, versionId: string, scope: HolderScope, cells: readonly SliceKey[],
): Promise<void> {
  if (!scope.reviewer) return;
  const open = scope.reviews.filter((r) => isLockedStatus(r.status) && cells.some((c) => sameSlice(r, c)));
  for (const r of open) {
    await sql`SELECT public.budget_slice_review_begin_slice(${companyId}::UUID, ${versionId}::UUID, ${r.cc1Id}::UUID, ${r.cc2Id}::UUID, ${r.buId}::UUID)`;
  }
}

/**
 * The filter a driver recompute runs on the cells it is about to write, before any write:
 * - a submitted or approved slice of a draft is FROZEN (r4, coordinator's ruling): no recompute writes
 *   into it, whoever saves and whatever input moved; those cells are left as they are and reported
 *   (`frozen`), and recalculate once the slice is returned;
 * - a holder's recompute that would land outside their (open) slices is a 409 BUDGET_SLICE_DRIVER
 *   naming the driver (their save cannot change another holder's figures).
 * Null when there is nothing to filter.
 */
export function driverSliceGuard(scope: HolderScope, versionStatus: string): DriverWriteGuard | null {
  const holder = isHolder(scope);
  const frozenApplies = versionStatus === 'draft' && scope.reviews.some((r) => isLockedStatus(r.status));
  if (!holder && !frozenApplies) return null;
  const guard: DriverWriteGuard = (writes, label) => {
    const keep: typeof writes[number][] = [];
    const frozen: typeof writes[number][] = [];
    for (const w of writes) {
      const cell = parseKey(`${w.rowKey}|${w.month}`);
      if (frozenApplies && isLockedStatus(scope.reviews.find((r) => sameSlice(r, cell))?.status ?? null)) { frozen.push(w); continue; }
      if (holder && sliceOf(scope.slices, cell) === null) {
        throw new BudgetVersionError('BUDGET_SLICE_DRIVER',
          `This change makes the driver on ${label(w.rowKey)} recompute month ${w.month}, which is outside your budget slices; ask an owner or admin to change that driver or its inputs`);
      }
      keep.push(w);
    }
    return { keep, frozen };
  };
  if (frozenApplies) {
    guard.frozenRows = (rows) => new Set(rows.filter((row) => {
      const cell = parseKey(`${row}|2000-01`);
      return isLockedStatus(scope.reviews.find((r) => sameSlice(r, cell))?.status ?? null);
    }));
  }
  return guard;
}

/**
 * A driver line's own row (its account and slice) as the driver routes may write it (r3): a holder only
 * inside their slices, nobody off the reviewer path into a submitted or approved slice of a draft. The
 * 409 names the driver; migration 955's budget_driver_lines trigger is the backstop.
 */
export function driverRowRefusal(scope: HolderScope, versionStatus: string, reviewerPath: boolean, rowKey: string, label: string): BudgetVersionError | null {
  const cell = parseKey(`${rowKey}|2000-01`);
  if (isHolder(scope) && (versionStatus !== 'draft' || sliceOf(scope.slices, cell) === null)) {
    return new BudgetVersionError('BUDGET_SLICE_DRIVER', `The driver on ${label} is outside your budget slices; ask an owner or admin to change it`);
  }
  if (versionStatus !== 'draft' || (scope.reviewer && reviewerPath)) return null;
  const status = scope.reviews.find((r) => sameSlice(r, cell))?.status ?? null;
  return isLockedStatus(status)
    ? new BudgetVersionError('BUDGET_SLICE_DRIVER', `The driver on ${label} is in a slice ${status === 'submitted' ? 'submitted for review' : 'already approved'}; return the slice first`)
    : null;
}

/**
 * The forecast roll (P4 auto-roll and Roll now) on a version with budget slices (r3): cells of a
 * submitted or approved slice of a draft are left as they are (counted in `skipped`), and a holder's
 * roll (an auto roll their close set off) is confined to their slices. Owners and admins take no
 * reviewer path here: a slice with its reviewer is not refreshed behind the reviewer's back.
 */
export function rollableCells(
  cells: ReadonlyMap<RowKey, readonly Cell[]>, scope: HolderScope, versionStatus: string,
): { cells: Map<RowKey, Cell[]>; skipped: number; locked: number; outside: number; slices: SliceKey[] } {
  const out = new Map<RowKey, Cell[]>();
  const slices: SliceKey[] = [];
  let locked = 0;
  let outside = 0;
  for (const [key, list] of cells) {
    const slice = parseKey(`${key}|2000-01`);
    // Under review first (it is frozen whoever rolls); then, for a holder, not theirs.
    if (versionStatus === 'draft' && isLockedStatus(scope.reviews.find((r) => sameSlice(r, slice))?.status ?? null)) {
      locked += list.length;
      if (!slices.some((x) => sameSlice(x, slice))) slices.push({ cc1Id: slice.cc1Id, cc2Id: slice.cc2Id, buId: slice.buId });
      continue;
    }
    if (isHolder(scope) && sliceOf(scope.slices, slice) === null) { outside += list.length; continue; }
    out.set(key, [...list]);
  }
  return { cells: out, skipped: locked + outside, locked, outside, slices };
}

/** "CC1 OPS Operations", "BU …", "Company level" for slices of the company (codes and names). */
export async function sliceKeyLabels(companyId: string, keys: readonly SliceKey[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const ids = [...new Set(keys.flatMap((k) => [k.cc1Id, k.cc2Id, k.buId].filter((x): x is string => x !== null)))];
  const rows = (await sql`
    SELECT id::TEXT AS id, code || ' ' || name AS label FROM cost_centres WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
    UNION ALL
    SELECT id::TEXT, code || ' ' || name FROM business_units WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];
  const name = new Map(rows.map((r) => [String(r.id), String(r.label)]));
  return keys.map((k) => (k.cc1Id ? `CC1 ${name.get(k.cc1Id) ?? k.cc1Id}` : k.cc2Id ? `CC2 ${name.get(k.cc2Id) ?? k.cc2Id}`
    : k.buId ? `BU ${name.get(k.buId) ?? k.buId}` : 'Company level'));
}

/**
 * Server writers acting for an owner or admin (the year-end rehome) take the reviewer path on each of
 * `versionIds` that has slice reviews, so moving a slice's months is theirs to do (r3). Anyone else
 * takes none, and migration 955 refuses their write into a slice with its reviewer.
 */
export async function beginReviewForOwner(companyId: string, versionIds: readonly string[], userId: string): Promise<void> {
  const rows = (await sql`
    SELECT v.id::TEXT AS id FROM unnest(${[...new Set(versionIds)]}::UUID[]) AS v(id)
     WHERE EXISTS (SELECT 1 FROM budget_slice_reviews r WHERE r.company_id = ${companyId}::UUID AND r.version_id = v.id)
       AND EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${userId}
                     AND cu.role IN ('owner', 'admin'))
  `) as DbRow[];
  for (const r of rows) await sql`SELECT public.budget_slice_review_begin(${companyId}::UUID, ${String(r.id)}::UUID)`;
}

/**
 * A driver-override reset (a clear the recompute is meant to refill) in a slice with its reviewer
 * would leave the cell EMPTY: the slice is frozen to recomputes (r5, breaker REPRO 7). Refused up
 * front, for everyone: 409 BUDGET_SLICE_LOCKED, return the slice first.
 */
export function assertNoFrozenReset(scope: HolderScope, versionStatus: string, rows: Iterable<string>, label: (accountId: string) => string): void {
  if (versionStatus !== 'draft') return;
  for (const row of rows) {
    const cell = parseKey(`${row}|2000-01`);
    if (isLockedStatus(scope.reviews.find((r) => sameSlice(r, cell))?.status ?? null)) {
      throw new BudgetVersionError('BUDGET_SLICE_LOCKED',
        `Resetting the driver override on ${label(cell.glAccountId)} would leave it empty: its slice is under review and its drivers are frozen. Return the slice first`);
    }
  }
}
