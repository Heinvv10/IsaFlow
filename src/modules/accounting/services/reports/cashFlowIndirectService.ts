/**
 * The indirect-method cash flow statement of the Reports screen and its CSV export, from the general ledger.
 *
 * Opening cash is `cash.balance.v1` the day before the period; the period's movement is the credit-less-debit of every
 * posted NON-cash journal line in it, each classified once (`placeJournal`: only the cash a journal actually moved shows
 * as an investing or financing flow). Because a journal balances, that
 * sum IS the change in cash, so on sound books closing cash equals the ledger's cash balance (a test holds it); when the
 * ledger breaks that (a posted journal that does not balance, a cash leg on a year-end journal) the statement still closes
 * on the ledger and shows the gap as its own `Unexplained Difference` section,
 * whatever the books carry. The year-end closing journal is ignored, both legs, as every statement does.
 *
 * Every query is scoped to `companyId`.
 */

import { toMoney } from '@/lib/money/decimalSum';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { log } from '@/lib/logger';
import { bucketSection, INDIRECT_BUCKETS, placeJournal, type IndirectBucket, type IndirectSection } from './cashFlowIndirectClassification';
import { fetchCashFlowJournals } from './cashFlowJournals';

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
   * Closing cash less what the posted journals' movements explain (opening + the sections before the Unexplained
   * Difference). Zero on a sound ledger; non-zero is a ledger fault (a posted journal that does not balance, a cash leg
   * on a year-end journal) and is shown as its own section, never absorbed into a line.
   */
  unexplainedDifference: number;
}

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
  non_cash: { label: 'Non-cash Investing and Financing Items', always: false },
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

/** The section that carries a difference the journals do not explain. */
export const UNEXPLAINED_SECTION = 'Unexplained Difference';
const UNEXPLAINED_LABEL = 'Unexplained difference: the ledger\'s cash does not follow from its posted journals';

export async function getIndirectCashFlow(companyId: string, startDate: string, endDate: string): Promise<IndirectCashFlow> {
  // Three reads, not one snapshot: under withAuth the request is already inside a READ COMMITTED transaction (the
  // isolation level cannot be raised after its first statement), so a journal posted by ANOTHER session between the movement
  // read and the ledger-cash read can show for one load as a small Unexplained Difference (and its warn log). It is transient
  // by construction: the next load reads both after the posting, and nothing is stored from it.
  const [openingCash, journals, ledgerClosing] = await Promise.all([
    getCashBalance(companyId, startDate, { exclusive: true }).then((b) => b.total),
    fetchCashFlowJournals(companyId, startDate, endDate),
    getCashBalance(companyId, endDate).then((b) => b.total),
  ]);

  const byBucket = new Map<IndirectBucket, number>(INDIRECT_BUCKETS.map((b) => [b, 0]));
  for (const { legs, netCash, disposal } of journals) {
    for (const { bucket, amount } of placeJournal(legs, netCash, disposal)) byBucket.set(bucket, byBucket.get(bucket)! + amount);
  }

  const sections: IndirectCashFlowSection[] = SECTIONS.map(({ key, title }) => {
    const items = INDIRECT_BUCKETS
      .filter((b) => bucketSection(b) === key)
      .map((b) => ({ bucket: b, amount: toMoney(byBucket.get(b)!) }))
      .filter((i) => LINES[i.bucket].always || i.amount !== 0)
      .map((i) => ({ label: LINES[i.bucket].label, amount: i.amount }));
    return { section: title, items, total: toMoney(items.reduce((s, i) => s + i.amount, 0)) };
  });

  const explained = toMoney(sections.reduce((s, x) => s + x.total, 0));
  // By double entry the journals' movements ARE the change in cash. When the ledger's own cash says otherwise, say so as
  // a section of its own: the statement still closes on the ledger, and the reader sees how much it could not explain.
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
