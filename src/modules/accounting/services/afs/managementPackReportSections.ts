// src/modules/accounting/services/afs/managementPackReportSections.ts
// The management pack's Cash Flow, Debtors Ageing, Creditors Ageing and Bank Reconciliation sections, built
// from the same services the reports use (getCashFlowDirect, getAgingReport, getReconciliations): the pack
// prints their figures and computes none of its own. Pure: the generator fetches the reports.
import { formatMoney } from '@/lib/money/formatMoney';
import type { BankReconciliation } from '../../types/bank.types';
import type { CashFlowDirectReport } from './cashFlowDirectService';
import type { AgingReport } from '../reports/agingReportService';
import type { NoteContentBlock, NoteContentTable, NoteTableRowKind } from './afsTypes';
import { NO_ACTIVITY } from './managementPackSections';
import { build, longDate, type Spec, type StatementColumn } from './managementPackStatements';

// ── Cash flow ────────────────────────────────────────────────────────────────

const cashItems = (items: CashFlowDirectReport['operatingItems']) =>
  items.map((i) => ({ accountCode: i.cashGroup, accountName: i.label, amount: i.amount }));
const labelOnly = (l: { accountName: string }) => l.accountName;

const CASH_SPEC: Spec<CashFlowDirectReport>[] = [
  { subtotal: { label: 'Opening cash', value: (r) => r.openingCash, kind: 'subtotal' } },
  { group: { heading: 'Operating activities', lines: (r) => cashItems(r.operatingItems), lineLabel: labelOnly, totalLabel: 'Net cash from operating activities', total: (r) => r.operatingTotal } },
  { group: { heading: 'Investing activities', lines: (r) => cashItems(r.investingItems), lineLabel: labelOnly, totalLabel: 'Net cash from investing activities', total: (r) => r.investingTotal } },
  { group: { heading: 'Financing activities', lines: (r) => cashItems(r.financingItems), lineLabel: labelOnly, totalLabel: 'Net cash from financing activities', total: (r) => r.financingTotal } },
  { subtotal: { label: 'Net change in cash', value: (r) => r.netChange, kind: 'subtotal' } },
  { subtotal: { label: 'Closing cash', value: (r) => r.closingCash, kind: 'total' } },
];

/** The statement for the pack month and, as the comparison mode asks, the month before and the same month a year earlier. */
export function cashFlowBlocks(columns: StatementColumn<CashFlowDirectReport>[], changeOnLastYear: boolean): NoteContentBlock[] {
  const built = build(CASH_SPEC, columns, changeOnLastYear);
  const table: NoteContentTable = {
    type: 'table',
    headers: ['', ...columns.map((c) => c.label), ...(changeOnLastYear ? ['Change on last year'] : [])],
    rows: built.rows, rowKinds: built.kinds,
  };
  return [table, ...(built.empty ? [{ type: 'paragraph' as const, text: NO_ACTIVITY.cash_flow }] : [])];
}

/** The figures behind the statement (snapshot and AI input): the report's own totals. */
export function cashFlowFigures(r: CashFlowDirectReport | undefined): Record<string, unknown> {
  return r ? {
    periodStart: r.periodStart, periodEnd: r.periodEnd, openingCash: r.openingCash, operatingTotal: r.operatingTotal,
    investingTotal: r.investingTotal, financingTotal: r.financingTotal, netChange: r.netChange, closingCash: r.closingCash,
  } : {};
}

// ── Ageing ───────────────────────────────────────────────────────────────────

/** Rows listed before the rest are folded into one; a pack page is not a ledger. */
export const AGEING_TOP = 10;
const AGEING_BUCKETS = ['Current', '30 days', '60 days', '90 days', '120+ days', 'Total'] as const;

const bucketCells = (b: { current: number; days30: number; days60: number; days90: number; days120Plus: number; total: number }): string[] =>
  [b.current, b.days30, b.days60, b.days90, b.days120Plus, b.total].map((n) => formatMoney(n));

/**
 * The aged balances at the report's date: the largest balances by name, the rest folded into one row, and the
 * report's own totals row (never a re-sum). What the report says it could not age, and the cash it left
 * unapplied, are printed under the table in words.
 */
export function ageingBlocks(report: AgingReport, side: 'ar' | 'ap'): NoteContentBlock[] {
  const who = side === 'ar' ? 'customer' : 'supplier';
  const cash = side === 'ar' ? 'receipts' : 'payments';
  if (report.buckets.length === 0 && report.excluded.length === 0) {
    return [{ type: 'paragraph', text: `No open ${who} balances at ${longDate(report.asAt)}.` }];
  }
  const showDisputed = side === 'ar' && report.totals.disputed !== 0;
  const sorted = [...report.buckets].sort((a, b) => b.total - a.total || a.entityName.localeCompare(b.entityName));
  const top = sorted.slice(0, AGEING_TOP);
  const rest = sorted.slice(AGEING_TOP);
  const cells = (b: Parameters<typeof bucketCells>[0] & { disputed?: number }): string[] =>
    [...bucketCells(b), ...(showDisputed ? [formatMoney(b.disputed ?? 0)] : [])];
  const sum = (key: 'current' | 'days30' | 'days60' | 'days90' | 'days120Plus' | 'total' | 'disputed') =>
    rest.reduce((s, b) => s + (key === 'disputed' ? (b.disputed ?? 0) : b[key]), 0);

  const rows: string[][] = top.map((b) => [b.entityName, ...cells(b)]);
  const kinds: NoteTableRowKind[] = top.map(() => 'line');
  if (rest.length > 0) {
    rows.push([`Other ${who}s (${rest.length})`, ...cells({
      current: sum('current'), days30: sum('days30'), days60: sum('days60'), days90: sum('days90'),
      days120Plus: sum('days120Plus'), total: sum('total'), disputed: sum('disputed'),
    })]);
    kinds.push('line');
  }
  rows.push(['Total', ...cells(report.totals)]);
  kinds.push('total');

  const table: NoteContentTable = {
    type: 'table',
    headers: [side === 'ar' ? 'Customer' : 'Supplier', ...AGEING_BUCKETS, ...(showDisputed ? ['Disputed'] : [])],
    rows, rowKinds: kinds,
  };
  const notes: string[] = [];
  if (rest.length > 0) notes.push(`${report.buckets.length} ${who}s have a balance; the ${AGEING_TOP} largest are listed.`);
  if (report.excluded.length > 0) {
    notes.push(`${report.excluded.length === 1 ? '1 document has' : `${report.excluded.length} documents have`} no due date and cannot be aged: ${formatMoney(report.excludedTotal)}, not in the columns above.`);
  }
  if (report.unappliedReceipts !== 0) notes.push(`Unapplied ${cash} on the control account: ${formatMoney(report.unappliedReceipts)}.`);
  return [table, ...notes.map((text) => ({ type: 'paragraph' as const, text }))];
}

export function ageingFigures(report: AgingReport | undefined): Record<string, unknown> {
  if (!report) return {};
  return {
    asAt: report.asAt, totals: report.totals, entities: report.buckets.length, excludedTotal: report.excludedTotal,
    unappliedReceipts: report.unappliedReceipts, subledgerTotal: report.subledgerTotal,
    largest: [...report.buckets].sort((a, b) => b.total - a.total).slice(0, 5).map((b) => ({ name: b.entityName, total: b.total })),
  };
}

// ── Bank reconciliation ──────────────────────────────────────────────────────

const STATUS_WORDS: Record<string, string> = { completed: 'Completed', in_progress: 'In progress' };

/** The latest session of each bank account on or before the pack month end, by account name. */
export function latestReconciliations(all: readonly BankReconciliation[], periodEnd: string): BankReconciliation[] {
  const latest = new Map<string, BankReconciliation>();
  for (const r of all) {
    if (r.statementDate > periodEnd) continue;
    const seen = latest.get(r.bankAccountId);
    if (!seen || r.statementDate > seen.statementDate || (r.statementDate === seen.statementDate && r.createdAt > seen.createdAt)) {
      latest.set(r.bankAccountId, r);
    }
  }
  return [...latest.values()].sort((a, b) => (a.bankAccountName ?? '').localeCompare(b.bankAccountName ?? '') || a.bankAccountId.localeCompare(b.bankAccountId));
}

export function bankReconciliationBlocks(all: readonly BankReconciliation[], periodEnd: string): NoteContentBlock[] {
  const rows = latestReconciliations(all, periodEnd);
  if (rows.length === 0) {
    return [{ type: 'paragraph', text: `No bank account has a reconciliation dated on or before ${longDate(periodEnd)}.` }];
  }
  const table: NoteContentTable = {
    type: 'table',
    headers: ['Bank account', 'Statement date', 'Statement balance', 'GL balance', 'Outstanding difference', 'Status'],
    rows: rows.map((r) => [
      r.bankAccountName ?? 'Unnamed account', longDate(r.statementDate), formatMoney(r.statementBalance),
      formatMoney(r.glBalance), formatMoney(r.difference), STATUS_WORDS[r.status] ?? r.status,
    ]),
  };
  return [table, { type: 'paragraph', text: 'The latest reconciliation of each account up to the end of the month is listed.' }];
}

export function bankReconciliationFigures(all: readonly BankReconciliation[] | undefined, periodEnd: string): Record<string, unknown> {
  if (!all) return {};
  return {
    asAt: periodEnd,
    accounts: latestReconciliations(all, periodEnd).map((r) => ({
      name: r.bankAccountName ?? null, statementDate: r.statementDate, statementBalance: r.statementBalance,
      glBalance: r.glBalance, difference: r.difference, status: r.status,
    })),
  };
}
