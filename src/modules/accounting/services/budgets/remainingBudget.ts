/**
 * Remaining budget, the reader (budgets P5 spec §3a with the census corrections). Gathers the rows
 * `remainingBudgetCore.computeRemaining` decides on; every query is company-scoped and runs on the
 * request's connection (app_user under RLS inside withAuth).
 *
 * - Version: P1's primary scope over the keys' months (`primaryVersionScopeAndYears`, census T1.4;
 *   `primaryVersionScope` no longer exists). A month two registry years share counts in the earlier.
 * - Grain: the `dim_grain` of the account's rows in that version (947: one grain per account).
 * - Actual: P3's one actuals read (`readTrackingActuals`), ONE call per grain level over the keys'
 *   window, as `priorActuals.ts` does, never a second formula. Invariant 1: equals the Budget vs
 *   Actual actual for the same account, slice and month.
 * - Committed: lines of POs with status approved / partially_received / received, in their
 *   order-date month, less the ex-VAT `line_total` of bill lines linked by `po_item_id` on bills that
 *   are approved / paid / partially_paid, per PO line, floored at 0 (derived from the bill linkage,
 *   never `quantity_invoiced`, which nothing writes). Only the REST bill create writes `po_item_id`,
 *   and there `line_total` is qty × unit price, ex-VAT (census finding 3/7).
 *
 * `opts.excludeInvoiceId`: the bill being checked. Its own lines linked to a PO line count as billed
 *   whatever its status, so the part of a commitment the bill itself consumes is not counted twice
 *   against it (decision 8a), while the rest of that PO line stays committed.
 * `opts.excludePoItemIds`: PO lines left out of committed entirely (a PO being approved previews
 *   against everything but itself).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { monthEnd, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { primaryVersionScopeAndYears } from './budgetVersionScope';
import { readTrackingActuals } from './tracking/trackingActualRead';
import {
  computeRemaining,
  GRAIN_BY_DIM,
  type BudgetAmountRow,
  type CommitmentRow,
  type GrainActualRow,
  type RemainingGrain,
  type RemainingKey,
  type RemainingResult,
} from './remainingBudgetCore';

export type { RemainingGrain, RemainingKey, RemainingResult } from './remainingBudgetCore';

export interface RemainingOptions {
  excludePoItemIds?: readonly string[];
  excludeInvoiceId?: string | null;
}

/** PO statuses whose lines commit spend; bill statuses whose linked lines release it. */
export const COMMITTING_PO_STATUSES = ['approved', 'partially_received', 'received'] as const;
export const BILLED_STATUSES = ['approved', 'paid', 'partially_paid'] as const;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const lower = (v: string | null | undefined): string | null => (v == null ? null : v.toLowerCase());
const text = (v: unknown): string | null => (v == null ? null : String(v).toLowerCase());

function normalise(k: RemainingKey): RemainingKey {
  if (!MONTH_KEY.test(k.month)) throw new Error(`remainingFor: month must be 'YYYY-MM', got ${k.month}`);
  return { glAccountId: k.glAccountId.toLowerCase(), cc1Id: lower(k.cc1Id), cc2Id: lower(k.cc2Id), buId: lower(k.buId), month: k.month };
}

async function readGrains(companyId: string, versions: string[], accounts: string[]): Promise<Map<string, RemainingGrain>> {
  if (versions.length === 0) return new Map();
  const rows = (await sql`
    SELECT DISTINCT version_id::TEXT AS version_id, gl_account_id::TEXT AS gl_account_id, dim_grain
      FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ANY(${versions}::UUID[]) AND gl_account_id = ANY(${accounts}::UUID[])
  `) as DbRow[];
  const out = new Map<string, RemainingGrain>();
  for (const r of rows) {
    const grain = GRAIN_BY_DIM[Number(r.dim_grain)];
    if (grain) out.set(`${text(r.version_id)}|${text(r.gl_account_id)}`, grain);
  }
  return out;
}

async function readBudgets(companyId: string, versions: string[], accounts: string[], monthDates: string[]): Promise<BudgetAmountRow[]> {
  if (versions.length === 0) return [];
  const rows = (await sql`
    SELECT version_id::TEXT AS version_id, gl_account_id::TEXT AS gl_account_id, to_char(month, 'YYYY-MM') AS month,
           cc1_id::TEXT AS cc1_id, cc2_id::TEXT AS cc2_id, bu_id::TEXT AS bu_id, amount::TEXT AS amount
      FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ANY(${versions}::UUID[])
       AND gl_account_id = ANY(${accounts}::UUID[]) AND month = ANY(${monthDates}::DATE[])
  `) as DbRow[];
  return rows.map((r) => ({
    versionId: String(text(r.version_id)), glAccountId: String(text(r.gl_account_id)), month: String(r.month),
    cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id), amount: Number(r.amount),
  }));
}

async function readCommitments(
  companyId: string, accounts: string[], start: string, end: string, opts: RemainingOptions,
): Promise<CommitmentRow[]> {
  const exclude = (opts.excludePoItemIds ?? []).map((id) => id.toLowerCase());
  const own = opts.excludeInvoiceId ? opts.excludeInvoiceId.toLowerCase() : null;
  const rows = (await sql`
    SELECT pi.id::TEXT AS po_item_id, pi.gl_account_id::TEXT AS gl_account_id, to_char(po.order_date, 'YYYY-MM') AS month,
           pi.cc1_id::TEXT AS cc1_id, pi.cc2_id::TEXT AS cc2_id, pi.bu_id::TEXT AS bu_id, pi.line_total::TEXT AS line_total,
           COALESCE((
             SELECT SUM(sii.line_total)
               FROM supplier_invoice_items sii
               JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
              WHERE sii.po_item_id = pi.id
                AND si.company_id = ${companyId}::UUID
                AND (si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) OR si.id = ${own}::UUID)
           ), 0)::TEXT AS billed
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${companyId}::UUID
       AND po.status = ANY(${[...COMMITTING_PO_STATUSES]}::TEXT[])
       AND pi.gl_account_id = ANY(${accounts}::UUID[])
       AND po.order_date >= ${start}::DATE AND po.order_date <= ${end}::DATE
       AND NOT (pi.id = ANY(${exclude}::UUID[]))
  `) as DbRow[];
  return rows.map((r) => ({
    poItemId: String(r.po_item_id), glAccountId: String(text(r.gl_account_id)), month: String(r.month),
    cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
    lineTotal: Number(r.line_total), billed: Number(r.billed),
  }));
}

/**
 * Budget, actual, committed and remaining for each key, in input order. `budget` (and so
 * `remaining`) is null for "No budget": no primary version, no budget for the account in it, the
 * unassigned slice, or no row for the slice and month. A budgeted zero is 0.
 */
export async function remainingFor(
  companyId: string, rawKeys: readonly RemainingKey[], opts: RemainingOptions = {},
): Promise<RemainingResult[]> {
  if (rawKeys.length === 0) return [];
  const keys = rawKeys.map(normalise);
  const months = [...new Set(keys.map((k) => k.month))].sort();
  const monthDates = months.map(monthKeyToDate);
  const start = monthDates[0]!;
  const end = monthEnd(monthDates[monthDates.length - 1]!);

  const { scope } = await primaryVersionScopeAndYears(companyId, start, end);
  const versionOf = (month: string): string | null => {
    const d = monthKeyToDate(month);
    return scope.find((s) => s.first <= d && d <= s.last)?.versionId?.toLowerCase() ?? null;
  };
  const accounts = [...new Set(keys.map((k) => k.glAccountId))];
  const versions = [...new Set(months.map(versionOf).filter((v): v is string => v !== null))];
  const grains = await readGrains(companyId, versions, accounts);

  // One actuals read per grain level the keys need (an account with no grain is read at company level).
  const levels = new Set<RemainingGrain>(keys.map((k) => {
    const v = versionOf(k.month);
    return (v === null ? undefined : grains.get(`${v}|${k.glAccountId}`)) ?? 'company';
  }));
  const actuals: GrainActualRow[] = [];
  for (const grain of [...levels].sort()) {
    for (const r of await readTrackingActuals(companyId, start, end, {}, grain === 'company' ? null : grain)) {
      actuals.push({ grain, accountId: r.accountId, month: r.month, memberId: r.memberId, amount: r.amount });
    }
  }

  return computeRemaining(keys, {
    versionOf,
    grains,
    budgets: await readBudgets(companyId, versions, accounts, monthDates),
    actuals,
    commitments: await readCommitments(companyId, accounts, start, end, opts),
  });
}
