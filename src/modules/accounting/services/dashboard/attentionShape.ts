/**
 * The dashboard's one "Needs attention" list: pure shaping, no I/O.
 *
 * It merges what used to be three lists (the /home "needs you" feed, the
 * "Today in the books" cards and Action Items) into one, each subject once:
 *  - one bank row (the workbench definition: unreconciled, posted lines),
 *  - one VAT row (the "VAT return due" work item, carrying the VAT201 period's
 *    net VAT when payable),
 *  - pay runs anchored on the current period: a run is its own row only for
 *    this SAST month or the month before; older open runs are one summary row
 *    and later months are not listed.
 *
 * The bureau work feed is reused as is (bureauWorkAggregatorService), minus the
 * two kinds of row this list replaces: its per-run pay-run rows and its bank
 * report row.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import {
  endOfNextMonth,
  severityForDate,
  PAY_RUN_WINDOW_MONTHS_BACK,
  type WorkItem,
} from '@/modules/bureau/services/bureauWorkTypes';
import type { OwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';
import type { HeadlineCounts } from '../reports/headlineFigures';

export type AttentionSeverity = 'overdue' | 'due_soon' | 'info';
export type AttentionArea = 'Sales' | 'Purchases' | 'Banking' | 'Accounting' | 'VAT' | 'Payroll' | 'Compliance';

export interface AttentionItem {
  key: string;
  area: AttentionArea;
  label: string;
  detail?: string;
  amount?: number | null;
  dueAt?: string | null;
  severity: AttentionSeverity;
  href: string;
}

export interface AttentionList { asAt: string; items: AttentionItem[] }

export interface OpenPayRun {
  id: string;
  periodYear: number;
  periodMonth: number;
  status: 'draft' | 'calculated' | 'approved';
}

export interface AttentionInput {
  /** YYYY-MM-DD, SAST. */
  asAt: string;
  today: Date;
  counts: HeadlineCounts;
  overdueInvoices: { count: number; amount: number };
  unreconciledBankTxns: number;
  openPriorPeriods: number;
  /** Every open run of the company. */
  payRuns: OpenPayRun[];
  /** aggregateBureauWork([companyId]).items */
  work: WorkItem[];
  /** Payroll and VAT sections; either may be null. */
  cash: OwnerCashPosition;
}

/** Work-item hrefs this list replaces with its own rows (owned by bureauWorkAggregatorService). */
export const REPLACED_PAY_RUN_HREF_PREFIX = '/payroll/runs/';
export const REPLACED_BANK_HREF = '/accounting/reports/bank-transactions';

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const RUN_DETAIL: Record<OpenPayRun['status'], string> = {
  draft: 'Draft',
  calculated: 'Calculated, not approved',
  approved: 'Approved, not paid',
};

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { overdue: 0, due_soon: 1, info: 2 };

const s = (n: number): string => (n === 1 ? '' : 's');
const monthLabel = (m: number, y: number): string => `${MONTH_FULL[m - 1] ?? '?'} ${y}`;
const periodIndex = (y: number, m: number): number => y * 12 + m;

function areaForHref(href: string): AttentionArea {
  if (href.startsWith('/payroll') || href.startsWith('/accounting/sars/emp')) return 'Payroll';
  if (href.startsWith('/accounting/sars/vat')) return 'VAT';
  if (href.startsWith('/accounting/bank')) return 'Banking';
  if (href.startsWith('/accounting/reports/ap-aging')) return 'Purchases';
  return 'Compliance';
}

function countRows(input: AttentionInput): AttentionItem[] {
  const { counts, overdueInvoices: oi, openPriorPeriods: opp } = input;
  const rows: AttentionItem[] = [];
  if (oi.count > 0) rows.push({ key: 'overdue-invoices', area: 'Sales', severity: 'overdue', label: `${oi.count} overdue invoice${s(oi.count)}`, amount: oi.amount, href: '/accounting/customer-invoices?filter=overdue' });
  if (counts.billsOverdue > 0) rows.push({ key: 'overdue-bills', area: 'Purchases', severity: 'overdue', label: `${counts.billsOverdue} overdue supplier bill${s(counts.billsOverdue)}`, href: '/accounting/supplier-invoices' });
  if (opp > 0) rows.push({ key: 'open-prior-periods', area: 'Accounting', severity: 'overdue', label: `${opp} prior period${s(opp)} still open`, href: '/accounting/fiscal-periods' });
  if (counts.billsDueNext7Days > 0) rows.push({ key: 'bills-due-7', area: 'Purchases', severity: 'due_soon', label: `${counts.billsDueNext7Days} bill${s(counts.billsDueNext7Days)} due in 7 days`, href: '/accounting/supplier-invoices?due_this_week=1' });
  return rows;
}

function payrollRows(input: AttentionInput): AttentionItem[] {
  const rows: AttentionItem[] = [];
  const p = input.cash.payroll;
  if (p && !p.canPay && p.totalRequired > 0) {
    const estimate = p.status === 'estimated' ? ' Estimate: the run is not approved yet.' : '';
    rows.push({
      key: 'payroll-shortfall', area: 'Payroll', severity: 'due_soon', amount: p.shortfall,
      label: `Cash is short for the ${p.periodLabel} pay run`,
      detail: `Cash ${formatMoney(input.cash.cash)} against ${formatMoney(p.totalRequired)} (net pay plus PAYE, UIF and SDL, less ETI)${estimate}`,
      href: `/payroll/runs/${p.runId}`,
    });
  }
  const cur = periodIndex(Number(input.asAt.slice(0, 4)), Number(input.asAt.slice(5, 7)));
  const older: OpenPayRun[] = [];
  for (const r of input.payRuns) {
    const idx = periodIndex(r.periodYear, r.periodMonth);
    if (idx > cur) continue;
    if (idx < cur - PAY_RUN_WINDOW_MONTHS_BACK) { older.push(r); continue; }
    const due = endOfNextMonth(r.periodMonth, r.periodYear);
    rows.push({
      key: `pay-run-${r.id}`, area: 'Payroll', severity: severityForDate(due, input.today),
      label: `${monthLabel(r.periodMonth, r.periodYear)} pay run`, detail: RUN_DETAIL[r.status],
      dueAt: due.toISOString(), href: `/payroll/runs/${r.id}`,
    });
  }
  if (older.length > 0) {
    const oldest = older.reduce((a, b) => (periodIndex(b.periodYear, b.periodMonth) < periodIndex(a.periodYear, a.periodMonth) ? b : a));
    rows.push({
      key: 'pay-runs-older', area: 'Payroll', severity: 'info',
      label: `${older.length} older pay run${s(older.length)} still open`,
      detail: `Oldest: ${monthLabel(oldest.periodMonth, oldest.periodYear)}`, href: '/payroll/runs',
    });
  }
  return rows;
}

function infoRows(input: AttentionInput): AttentionItem[] {
  const { unreconciledBankTxns: bank, counts } = input;
  const rows: AttentionItem[] = [];
  if (bank > 0) rows.push({ key: 'bank-unreconciled', area: 'Banking', severity: 'info', label: `${bank} unreconciled bank transaction${s(bank)}`, href: '/accounting/bank-transactions' });
  if (counts.draftInvoices > 0) rows.push({ key: 'draft-invoices', area: 'Sales', severity: 'info', label: `${counts.draftInvoices} draft invoice${s(counts.draftInvoices)}`, href: '/accounting/customer-invoices?filter=draft' });
  if (counts.draftJournals > 0) rows.push({ key: 'draft-journals', area: 'Accounting', severity: 'info', label: `${counts.draftJournals} draft journal${s(counts.draftJournals)}`, href: '/accounting/journal-entries' });
  return rows;
}

function workRows(input: AttentionInput): AttentionItem[] {
  const vat = input.cash.vat;
  return input.work
    .filter((w) => !w.href.startsWith(REPLACED_PAY_RUN_HREF_PREFIX) && w.href !== REPLACED_BANK_HREF)
    .map((w) => {
      // The net VAT belongs to one period only: the row whose due date is that period's.
      const samePeriod = !!vat && (w.dueAt ?? '').slice(0, 10) === vat.dueDate.slice(0, 10);
      const vatAmount = w.task === 'VAT return due' && vat && samePeriod && vat.netVat > 0 ? vat.netVat : null;
      return {
        key: `work-${w.task}-${w.href}-${w.dueAt ?? ''}`,
        area: areaForHref(w.href),
        severity: w.severity,
        label: w.task,
        detail: w.detail,
        amount: vatAmount ?? w.amount ?? null,
        dueAt: w.dueAt,
        href: w.href,
      };
    });
}

/** Rows deduped by key (first wins), then: severity, due date (undated last), the order built. */
export function shapeAttention(input: AttentionInput): AttentionItem[] {
  const all = [...countRows(input), ...payrollRows(input), ...infoRows(input), ...workRows(input)];
  const seen = new Set<string>();
  const unique = all.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return unique
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity];
      if (sev !== 0) return sev;
      const ad = a.item.dueAt ?? null;
      const bd = b.item.dueAt ?? null;
      if (ad && bd && ad !== bd) return ad.localeCompare(bd);
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return a.order - b.order;
    })
    .map(({ item }) => item);
}
