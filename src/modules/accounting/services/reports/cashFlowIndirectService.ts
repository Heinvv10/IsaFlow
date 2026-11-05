/**
 * The indirect-method cash flow statement of the Reports screen and its CSV export, from the general ledger.
 *
 * Opening cash is `cash.balance.v1` the day before the period; the period's movement is the credit-less-debit of every
 * posted NON-cash journal line in it, each classified once (`classifyIndirectLine`). Because a journal balances, that
 * sum IS the change in cash, so closing cash equals the ledger's cash balance by construction (and a test holds it),
 * whatever the books carry. The year-end closing journal is ignored, both legs, as every statement does.
 *
 * Every query is scoped to `companyId`.
 */

import { sql } from '@/lib/neon';
import { toMoney } from '@/lib/money/decimalSum';
import { CASH_SUBTYPES, isDisposalGainLossSubtype, type AccountType } from '@/modules/accounting/services/gl/accountSubtypes';
import { log } from '@/lib/logger';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import {
  bucketSection, classifyIndirectLine, INDIRECT_BUCKETS, type IndirectBucket, type IndirectSection,
} from './cashFlowIndirectClassification';

export interface IndirectCashFlowItem { label: string; amount: number }
export interface IndirectCashFlowSection { section: string; items: IndirectCashFlowItem[]; total: number }
export interface IndirectCashFlow {
  periodStart: string;
  periodEnd: string;
  openingCash: number;
  sections: IndirectCashFlowSection[];
  netChange: number;
  /** Always the ledger's cash balance at the end date (`cash.balance.v1`). */
  closingCash: number;
  /**
   * Closing cash less what the posted journals' movements explain (opening + the sections before this line). Zero on a
   * sound ledger; non-zero is a ledger fault (a posted journal that does not balance, a cash leg on a year-end journal)
   * and is shown as its own section, never absorbed into a line.
   */
  unexplainedDifference: number;
}

interface MovementRow { account_type: AccountType; account_subtype: string | null; debit: string | number | null; credit: string | number | null }

/** Label per line; `always` lines show at zero (the screen's long-standing layout), the others only when they moved. */
const LINES: Record<IndirectBucket, { label: string; always: boolean }> = {
  net_income: { label: 'Net Income', always: true },
  receivable: { label: 'Change in Accounts Receivable', always: true },
  payable: { label: 'Change in Accounts Payable', always: true },
  depreciation: { label: 'Depreciation and Amortisation (non-cash)', always: false },
  disposal_adjustment: { label: '(Gain) / Loss on Disposal of Assets', always: false },
  inventory: { label: 'Change in Inventory', always: false },
  vat: { label: 'Change in VAT Control', always: false },
  other_operating: { label: 'Change in Other Operating Assets and Liabilities', always: false },
  investing: { label: 'Fixed Asset Changes', always: true },
  equity: { label: 'Equity Changes', always: true },
  debt: { label: 'Change in Loans and Borrowings', always: false },
  retained_earnings: { label: 'Retained Earnings Movements (other than the year-end close)', always: false },
};

const SECTIONS: Array<{ key: IndirectSection; title: string }> = [
  { key: 'operating', title: 'Operating Activities' },
  { key: 'investing', title: 'Investing Activities' },
  { key: 'financing', title: 'Financing Activities' },
];

/** Posted credit-less-debit of every non-cash account in the period, grouped by type and subtype. */
async function fetchNonCashMovement(companyId: string, startDate: string, endDate: string): Promise<MovementRow[]> {
  return (await sql`
    SELECT ga.account_type, ga.account_subtype,
           COALESCE(SUM(jl.debit), 0)::numeric  AS debit,
           COALESCE(SUM(jl.credit), 0)::numeric AS credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date BETWEEN ${startDate} AND ${endDate}
      -- The cash accounts are what is being explained (the same predicate as cash.balance.v1).
      AND NOT (ga.account_type = 'asset' AND COALESCE(ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}), false))
    GROUP BY ga.account_type, ga.account_subtype
  `) as MovementRow[];
}

/** The label of the section that carries a difference the journals do not explain. */
export const UNEXPLAINED_SECTION = 'Unexplained Difference';
const UNEXPLAINED_LABEL = 'Unexplained difference: the ledger\'s cash does not follow from its posted journals';

/** Adds one movement row's amounts to the lines: where it belongs, plus the disposal presentation. */
function place(byBucket: Map<IndirectBucket, number>, r: MovementRow): void {
  const credit = Number(r.credit ?? 0);
  const debit = Number(r.debit ?? 0);
  const add = (b: IndirectBucket, v: number) => byBucket.set(b, byBucket.get(b)! + v);
  const bucket = classifyIndirectLine(r.account_type, r.account_subtype);
  if (bucket === 'depreciation') {
    // The charge (a credit) is added back; a RELEASE (a debit: the asset was sold or scrapped) leaves with the asset, in investing.
    add('depreciation', credit);
    add('investing', -debit);
    return;
  }
  add(bucket, credit - debit);
  if (bucket === 'net_income' && isDisposalGainLossSubtype(r.account_subtype)) {
    // The gain is in net income; the proceeds are investing. Take it out of operating and put it with the proceeds.
    add('disposal_adjustment', -(credit - debit));
    add('investing', credit - debit);
  }
}

export async function getIndirectCashFlow(companyId: string, startDate: string, endDate: string): Promise<IndirectCashFlow> {
  const [openingCash, rows, ledgerClosing] = await Promise.all([
    getCashBalance(companyId, startDate, { exclusive: true }).then((b) => b.total),
    fetchNonCashMovement(companyId, startDate, endDate),
    getCashBalance(companyId, endDate).then((b) => b.total),
  ]);

  const byBucket = new Map<IndirectBucket, number>(INDIRECT_BUCKETS.map((b) => [b, 0]));
  for (const r of rows) place(byBucket, r);

  const sections: IndirectCashFlowSection[] = SECTIONS.map(({ key, title }) => {
    const items = INDIRECT_BUCKETS
      .filter((b) => bucketSection(b) === key)
      .map((b) => ({ bucket: b, amount: toMoney(byBucket.get(b)!) }))
      .filter((i) => LINES[i.bucket].always || i.amount !== 0)
      .map((i) => ({ label: LINES[i.bucket].label, amount: i.amount }));
    return { section: title, items, total: toMoney(items.reduce((s, i) => s + i.amount, 0)) };
  });

  const explained = toMoney(sections.reduce((s, x) => s + x.total, 0));
  // By double entry the journals' movements ARE the change in cash. When the ledger's own cash says otherwise, say so
  // as a line of its own: the statement still closes on the ledger, and the reader sees how much it could not explain.
  const unexplainedDifference = toMoney(ledgerClosing - openingCash - explained);
  if (unexplainedDifference !== 0) {
    sections.push({ section: UNEXPLAINED_SECTION, items: [{ label: UNEXPLAINED_LABEL, amount: unexplainedDifference }], total: unexplainedDifference });
    log.warn('Cash flow statement does not tie to the ledger cash', { companyId, startDate, endDate, openingCash, explained, ledgerClosing, unexplainedDifference }, 'cash-flow-indirect');
  }

  return {
    periodStart: startDate, periodEnd: endDate, openingCash, sections,
    netChange: toMoney(explained + unexplainedDifference), closingCash: toMoney(ledgerClosing), unexplainedDifference,
  };
}
