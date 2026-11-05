// src/modules/accounting/services/afs/managementPackReportSections.ts
// The management pack's Cash Flow, Debtors Ageing, Creditors Ageing and Bank Reconciliation sections.
// Cash flow is the DIRECT-method statement (getCashFlowDirect), not the indirect statement the Reports screen
// builds inline. Ageing is the Aged Debtors / Aged Creditors services' own rows (getARAging / getAPAging) under
// the screens' bucket labels; the bank reconciliation is the stored sessions (getReconciliations) beside the
// company's bank accounts. The pack prints their figures and computes none of its own beyond column sums and
// the statement-less-GL difference. Pure: the generator fetches the reports.
import { formatMoney } from '@/lib/money/formatMoney';
import type { BankReconciliation } from '../../types/bank.types';
import type { CashFlowDirectReport } from './cashFlowDirectService';
import type { AgingBucket } from '../../types/ap.types';
import type { NoteContentBlock, NoteContentTable, NoteTableRowKind } from './afsTypes';
import { CASH_FLOW_METHOD, NO_ACTIVITY } from './managementPackSections';
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
  return [table, { type: 'paragraph' as const, text: CASH_FLOW_METHOD }, ...(built.empty ? [{ type: 'paragraph' as const, text: NO_ACTIVITY.cash_flow }] : [])];
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
/** The Aged Debtors / Aged Creditors screens' own column labels (the service's days30 is "1–30 Days", days120Plus is "90+ Days"). */
export const AGEING_HEADERS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Total'] as const;

/** What the ageing services returned for one side at the month end. */
export interface AgeingData {
  asAt: string;
  /** getARAging / getAPAging: one row per customer or supplier, gross of unapplied credit, aged from the due date (invoice date when there is none). */
  buckets: AgingBucket[];
  /** Receipts / payments and credit notes not applied to any document (getUnappliedByEntity, summed). */
  unapplied: number;
  /** Entities with unapplied credit and no open document, so in no row above (a name, for the document only). */
  creditOnly: Array<{ name: string; amount: number }>;
}

type Cols = { current: number; days30: number; days60: number; days90: number; days120Plus: number; total: number; disputed?: number };
const COLS = ['current', 'days30', 'days60', 'days90', 'days120Plus', 'total'] as const;
const cents = (n: number) => Math.round(n * 100) / 100;
/**
 * What an entity owes: its five age columns plus what is in dispute. The service keeps disputed amounts out of the age buckets;
 * its own `total` has been net of them (and, once the Aged Receivables fix lands, includes them), so the pack sums the columns
 * and never adds `disputed` to a total that may already hold it.
 */
const owed = (b: AgingBucket): AgingBucket => ({
  ...b, total: cents(b.current + b.days30 + b.days60 + b.days90 + b.days120Plus + (b.disputed ?? 0)),
});
const sumCols = (rows: readonly Cols[]): Cols => {
  const out: Cols = { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 0, disputed: 0 };
  for (const r of rows) {
    for (const k of COLS) out[k] = cents(out[k] + r[k]);
    out.disputed = cents((out.disputed ?? 0) + (r.disputed ?? 0));
  }
  return out;
};

/**
 * The aged balances at the month end: the largest by size, the rest folded into one row, and a total that is the
 * sum of every row (what the screen's footer is). What sits unapplied is printed in words under the table.
 */
export function ageingBlocks(data: AgeingData, side: 'ar' | 'ap'): NoteContentBlock[] {
  const who = side === 'ar' ? 'customer' : 'supplier';
  const cash = side === 'ar' ? 'receipts and credit notes' : 'payments and credit notes';
  const creditOnly = data.creditOnly.slice(0, AGEING_TOP).map((c) => `${c.name} (${formatMoney(c.amount)})`).join(', ')
    + (data.creditOnly.length > AGEING_TOP ? ` and ${data.creditOnly.length - AGEING_TOP} more` : '');
  const unappliedNote: NoteContentBlock[] = [
    ...(Math.abs(data.unapplied) >= 0.005
      ? [{ type: 'paragraph' as const, text: `Unapplied ${cash} standing against ${who}s: ${formatMoney(data.unapplied)}. The columns above are before them.` }] : []),
    ...(data.creditOnly.length > 0 ? [{ type: 'paragraph' as const, text: `${who === 'customer' ? 'Customers' : 'Suppliers'} with credit and no open document, so in no row above: ${creditOnly}.` }] : []),
  ];
  if (data.buckets.length === 0) {
    return [{ type: 'paragraph', text: `No open ${who} balances at ${longDate(data.asAt)}.` }, ...unappliedNote];
  }
  // Total is what is owed, disputed amounts included; they are out of the age columns, so Disputed sits beside them and the row foots.
  const rows0 = data.buckets.map(owed);
  const total = sumCols(rows0);
  const showDisputed = side === 'ar' && (total.disputed ?? 0) !== 0;
  const sorted = [...rows0].sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.entityName.localeCompare(b.entityName));
  const top = sorted.slice(0, AGEING_TOP);
  const rest = sorted.slice(AGEING_TOP);
  const cells = (b: Cols): string[] => [
    ...COLS.slice(0, 5).map((k) => formatMoney(b[k])),
    ...(showDisputed ? [formatMoney(b.disputed ?? 0)] : []),
    formatMoney(b.total),
  ];

  const rows: string[][] = top.map((b) => [b.entityName, ...cells(b)]);
  const kinds: NoteTableRowKind[] = top.map(() => 'line');
  if (rest.length > 0) {
    rows.push([`Other ${who}s (${rest.length})`, ...cells(sumCols(rest))]);
    kinds.push('line');
  }
  rows.push(['Total', ...cells(total)]);
  kinds.push('total');

  const table: NoteContentTable = {
    type: 'table',
    headers: [side === 'ar' ? 'Customer' : 'Supplier', ...AGEING_HEADERS.slice(0, 5), ...(showDisputed ? ['Disputed'] : []), 'Total'],
    rows, rowKinds: kinds,
  };
  const notes: NoteContentBlock[] = rest.length > 0
    ? [{ type: 'paragraph', text: `${data.buckets.length} ${who}s have a balance; the ${AGEING_TOP} largest are listed.` }] : [];
  return [table, ...notes, ...unappliedNote];
}

/**
 * The figures the AI is told: buckets, counts and amounts only. No customer, supplier or bank account name leaves
 * the pack for the model (a name is personal data of a third party, a bank account's name can carry its number, and
 * the commentary needs neither).
 */
export function ageingFigures(data: AgeingData | undefined): Record<string, unknown> {
  if (!data) return {};
  return {
    asAt: data.asAt, totals: sumCols(data.buckets.map(owed)), entities: data.buckets.length, unapplied: data.unapplied,
    creditOnlyEntities: data.creditOnly.length, creditOnlyTotal: cents(data.creditOnly.reduce((s, c) => s + c.amount, 0)),
    largestBalances: data.buckets.map((b) => owed(b).total).sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 5),
  };
}

// ── Bank reconciliation ──────────────────────────────────────────────────────

/** The reconciliation sessions beside the company's bank accounts, so an account never reconciled is not silently absent. */
export interface ReconciliationData {
  sessions: BankReconciliation[];
  accounts: Array<{ id: string; name: string }>;
}

const stamp = (s: string): number => { const t = new Date(s).getTime(); return Number.isNaN(t) ? 0 : t; };

/** Later statement date first; on one date the later-created, by instant (never by the text of a Date), then the id. */
const newer = (a: BankReconciliation, b: BankReconciliation): boolean =>
  a.statementDate !== b.statementDate ? a.statementDate > b.statementDate
    : stamp(a.createdAt) !== stamp(b.createdAt) ? stamp(a.createdAt) > stamp(b.createdAt) : a.id > b.id;

/** The latest session of each account in `status` dated on or before the month end. */
function latestByAccount(all: readonly BankReconciliation[], periodEnd: string, status: BankReconciliation['status']): Map<string, BankReconciliation> {
  const latest = new Map<string, BankReconciliation>();
  for (const r of all) {
    if (r.status !== status || r.statementDate > periodEnd) continue;
    const seen = latest.get(r.bankAccountId);
    if (!seen || newer(r, seen)) latest.set(r.bankAccountId, r);
  }
  return latest;
}

export function latestReconciliations(all: readonly BankReconciliation[], periodEnd: string): BankReconciliation[] {
  return [...latestByAccount(all, periodEnd, 'completed').values()]
    .sort((a, b) => (a.bankAccountName ?? '').localeCompare(b.bankAccountName ?? '') || a.bankAccountId.localeCompare(b.bankAccountId));
}

export function bankReconciliationBlocks(data: ReconciliationData, periodEnd: string): NoteContentBlock[] {
  const done = latestByAccount(data.sessions, periodEnd, 'completed');
  const open = latestByAccount(data.sessions, periodEnd, 'in_progress');
  const names = new Map<string, string>(data.accounts.map((a) => [a.id, a.name]));
  for (const r of data.sessions) if (!names.has(r.bankAccountId)) names.set(r.bankAccountId, r.bankAccountName ?? 'Unnamed account');
  if (names.size === 0) return [{ type: 'paragraph', text: 'The company has no bank accounts.' }];

  const accounts = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  const dash = '—';
  const rows = accounts.map(([id, name]) => {
    const r = done.get(id);
    return r
      ? [name, longDate(r.statementDate), formatMoney(r.statementBalance), formatMoney(r.glBalance), formatMoney(r.reconciledBalance), formatMoney(cents(r.statementBalance - r.glBalance))]
      : [name, 'No reconciliation', dash, dash, dash, dash];
  });
  const table: NoteContentTable = {
    type: 'table',
    headers: ['Bank account', 'Statement date', 'Statement balance', 'GL balance', 'Reconciled balance', 'Statement less GL'],
    rows, rowKinds: rows.map(() => 'line'),
  };
  const inProgress = accounts.flatMap(([id, name]) => {
    const o = open.get(id);
    const c = done.get(id);
    return o && (!c || o.statementDate > c.statementDate)
      ? [{ type: 'paragraph' as const, text: `${name}: a reconciliation to ${longDate(o.statementDate)} is in progress and not included.` }] : [];
  });
  return [
    table, ...inProgress,
    { type: 'paragraph', text: 'The latest completed reconciliation of each account up to the end of the month is listed, with the figures stored when it was made, as at its statement date.' },
  ];
}

export function bankReconciliationFigures(data: ReconciliationData | undefined, periodEnd: string): Record<string, unknown> {
  if (!data) return {};
  return {
    asAt: periodEnd,
    accounts: latestReconciliations(data.sessions, periodEnd).map((r) => ({
      statementDate: r.statementDate, statementBalance: r.statementBalance,
      glBalance: r.glBalance, reconciledBalance: r.reconciledBalance, statementLessGl: cents(r.statementBalance - r.glBalance),
    })),
    accountsWithoutReconciliation: data.accounts.filter((a) => !latestByAccount(data.sessions, periodEnd, 'completed').has(a.id)).length,
  };
}
