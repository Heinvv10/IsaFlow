/**
 * The headline figures: ONE definition per measure, as at ONE SAST date, read by
 * every screen that shows them (/accounting overview and hero, /home and the
 * bureau client home, the Month-End workbench, the "Today in the books" cards
 * and Action Items).
 *
 * The rule: every figure is the posted ledger as at `asAt` (todayInSast() unless
 * given); nothing dated after `asAt` counts. Each money figure has an owner that
 * already exists and is reused here, never re-derived:
 *   cash         bank/cashBalanceService#getCashBalance (ledger basis, bank and
 *                cash subtypes, is_active never a filter)
 *   receivables  reports/dashboardOpenBook#getOpenBook('ar'), the aged debtors population
 *   payables     reports/dashboardOpenBook#getOpenBook('ap'), the aged creditors population
 *   revenueMtd   reports/mtdIncome (turnover, 1st of the month to `asAt`)
 *   profitMtd    reports/mtdIncome (every revenue account less every expense)
 * The counts are one statement below (getHeadlineCounts). Every query is scoped
 * by company_id.
 *
 * It throws when any reader fails: a screen shows a dash and Retry, never R 0.00
 * standing in for a figure it could not read.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { getCashBalance } from '../bank/cashBalanceService';
import { getOpenBook, type OpenBook } from './dashboardOpenBook';
import { getMtdIncome, type MtdIncome } from './mtdIncome';
import { DUE_THIS_WEEK_DAYS } from '../ap/supplierInvoiceWhereBuilder';

export interface HeadlineCounts {
  /** Customer invoices in draft, not soft-deleted. */
  draftInvoices: number;
  /** Supplier bills in draft, not soft-deleted. */
  draftBills: number;
  /** Journal entries in draft, any date. */
  draftJournals: number;
  /**
   * Open supplier bills with a balance, due from `asAt` to `asAt` + 7 days, both ends
   * included. The supplier list's "Due this week" filter is the same population.
   */
  billsDueNext7Days: number;
  /** Open supplier bills with a balance, due before `asAt`. */
  billsOverdue: number;
}

export interface HeadlineFigures extends HeadlineCounts {
  /** YYYY-MM-DD (SAST) every figure is stated at. */
  asAt: string;
  /** The 1st of `asAt`'s month: the start of the month-to-date window. */
  monthStart: string;
  cash: number;
  receivables: { total: number; overdue: number };
  payables: { total: number; overdue: number };
  revenueMtd: number;
  profitMtd: number;
}

/** One statement, five counts. `asAt` dates the two bill windows. */
export async function getHeadlineCounts(companyId: string, asAt: string = todayInSast()): Promise<HeadlineCounts> {
  const open = Array.from(AP_OPEN_STATUSES);
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM customer_invoices
        WHERE company_id = ${companyId}::UUID AND status = 'draft' AND deleted_at IS NULL) AS draft_invoices,
      (SELECT COUNT(*)::int FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND status = 'draft' AND deleted_at IS NULL) AS draft_bills,
      (SELECT COUNT(*)::int FROM gl_journal_entries
        WHERE company_id = ${companyId}::UUID AND status = 'draft') AS draft_journals,
      (SELECT COUNT(*)::int FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
          AND status = ANY(${open}::text[])
          AND total_amount - COALESCE(amount_paid, 0) > 0
          AND due_date >= ${asAt}::DATE AND due_date <= ${asAt}::DATE + ${DUE_THIS_WEEK_DAYS}::int) AS bills_due_7,
      (SELECT COUNT(*)::int FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
          AND status = ANY(${open}::text[])
          AND total_amount - COALESCE(amount_paid, 0) > 0
          AND due_date < ${asAt}::DATE) AS bills_overdue
  `) as DbRow[];
  const r = rows[0] ?? {};
  return {
    draftInvoices: Number(r.draft_invoices ?? 0),
    draftBills: Number(r.draft_bills ?? 0),
    draftJournals: Number(r.draft_journals ?? 0),
    billsDueNext7Days: Number(r.bills_due_7 ?? 0),
    billsOverdue: Number(r.bills_overdue ?? 0),
  };
}

/** Draft journals, optionally only those dated on or before `datedUpTo` (Month-End's period end). */
export async function countDraftJournals(companyId: string, datedUpTo?: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt FROM gl_journal_entries
     WHERE company_id = ${companyId}::UUID AND status = 'draft'
       AND (${datedUpTo ?? null}::DATE IS NULL OR entry_date <= ${datedUpTo ?? null}::DATE)
  `) as DbRow[];
  return Number(rows[0]?.cnt ?? 0);
}

/** `books` and `mtd`: the open books and month-to-date income when the caller already read them at the same `asAt`. */
export async function getHeadlineFigures(
  companyId: string,
  asAt: string = todayInSast(),
  opts: { books?: { ar: OpenBook; ap: OpenBook }; mtd?: MtdIncome } = {},
): Promise<HeadlineFigures> {
  const [cash, ar, ap, income, counts] = await Promise.all([
    getCashBalance(companyId, asAt),
    opts.books ? opts.books.ar : getOpenBook(companyId, 'ar', asAt),
    opts.books ? opts.books.ap : getOpenBook(companyId, 'ap', asAt),
    opts.mtd ?? getMtdIncome(companyId, asAt),
    getHeadlineCounts(companyId, asAt),
  ]);
  return {
    asAt,
    monthStart: `${asAt.slice(0, 8)}01`,
    cash: cash.total,
    receivables: { total: ar.total, overdue: ar.overdue },
    payables: { total: ap.total, overdue: ap.overdue },
    revenueMtd: income.revenueMtd,
    profitMtd: income.profitMtd,
    ...counts,
  };
}
