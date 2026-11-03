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
 * The reviewer path (migration 955): marks this transaction as an owner's or admin's review of
 * the version's slices, so the trigger lets them change a submitted or approved slice. Only when
 * the version has slice reviews (nothing to unlock otherwise).
 */
export async function beginSliceReview(companyId: string, versionId: string, scope: HolderScope): Promise<void> {
  if (!scope.reviewer || scope.reviews.length === 0) return;
  await sql`SELECT public.budget_slice_review_begin(${companyId}::UUID, ${versionId}::UUID)`;
}

/**
 * The check a driver recompute runs on the cells it is about to write (r2), so a driver that would
 * land outside the writer's reach is a 409 BUDGET_SLICE_DRIVER naming the driver, before any write,
 * instead of migration 955's generic refusal mid-write: a holder's recompute outside their slices; a
 * recompute into a submitted/approved slice of a draft by anyone not on the reviewer path (the driver
 * routes never take it: `reviewerPath` false). Null when nothing can be refused.
 */
export function driverSliceGuard(scope: HolderScope, versionStatus: string, reviewerPath: boolean): DriverWriteGuard | null {
  const holder = isHolder(scope);
  const lockApplies = versionStatus === 'draft' && !(scope.reviewer && reviewerPath) && scope.reviews.some((r) => isLockedStatus(r.status));
  if (!holder && !lockApplies) return null;
  return (writes, label) => {
    for (const w of writes) {
      const cell = parseKey(`${w.rowKey}|${w.month}`);
      if (holder && sliceOf(scope.slices, cell) === null) {
        throw new BudgetVersionError('BUDGET_SLICE_DRIVER',
          `This change makes the driver on ${label(w.rowKey)} recompute month ${w.month}, which is outside your budget slices; ask an owner or admin to change that driver or its inputs`);
      }
      const status = lockApplies ? scope.reviews.find((r) => sameSlice(r, cell))?.status ?? null : null;
      if (isLockedStatus(status)) {
        throw new BudgetVersionError('BUDGET_SLICE_DRIVER',
          `This change makes the driver on ${label(w.rowKey)} recompute month ${w.month} of a slice ${status === 'submitted' ? 'submitted for review' : 'already approved'}; return the slice first, or make the change in the grid as its reviewer`);
      }
    }
  };
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
): { cells: Map<RowKey, Cell[]>; skipped: number } {
  const out = new Map<RowKey, Cell[]>();
  let skipped = 0;
  for (const [key, list] of cells) {
    const slice = parseKey(`${key}|2000-01`);
    const locked = versionStatus === 'draft' && isLockedStatus(scope.reviews.find((r) => sameSlice(r, slice))?.status ?? null);
    const outside = isHolder(scope) && sliceOf(scope.slices, slice) === null;
    if (locked || outside) { skipped += list.length; continue; }
    out.set(key, [...list]);
  }
  return { cells: out, skipped };
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
