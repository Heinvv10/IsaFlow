import { getCashBalance } from '../bank/cashBalanceService';
import { log } from '@/lib/logger';
import { toMoney } from '@/lib/money/decimalSum';
import { failedReadLabel } from '@/modules/accounting/services/packs/packFailedRead';
import { journalSections } from '@/modules/accounting/services/reports/cashFlowIndirectClassification';
import { fetchCashFlowJournals, type CashFlowJournal } from '@/modules/accounting/services/reports/cashFlowJournals';
import {
  apportionBankLeg,
  OPERATING_GROUPS,
  type CashGroup,
  type ContraLine,
} from './cashFlowClassification';

export interface DirectCashFlowItem {
  cashGroup: string;
  label: string;
  amount: number;
}

export interface CashFlowDirectReport {
  periodStart: string;
  periodEnd: string;
  openingCash: number;
  operatingItems: DirectCashFlowItem[];
  operatingTotal: number;
  investingItems: DirectCashFlowItem[];
  investingTotal: number;
  financingItems: DirectCashFlowItem[];
  financingTotal: number;
  /** Net change less the three activities: zero on a sound ledger, a ledger fault otherwise (never absorbed into a line). */
  unexplainedDifference: number;
  netChange: number;
  /** Always the ledger's cash balance at the end date (`cash.balance.v1`). */
  closingCash: number;
}

const CASH_GROUP_LABELS: Record<CashGroup, string> = {
  cash_received_from_customers: 'Cash received from customers',
  cash_paid_to_suppliers:       'Cash paid to suppliers',
  cash_paid_to_employees:       'Cash paid to employees',
  other_operating:              'Other operating cash flows',
  investing:                    'Net investing cash flows',
  financing:                    'Net financing cash flows',
};

const OPERATING_ORDER: CashGroup[] = [
  'cash_received_from_customers',
  'cash_paid_to_suppliers',
  'cash_paid_to_employees',
  'other_operating',
];

/**
 * Opening cash — `cash.balance.v1`, from its owning service.
 *
 * This function used to carry its own copy of the query. It had the right basis
 * (posted GL movement on bank-subtype accounts) and kept it private, so the
 * dashboard and the balance sheet each grew their own and cash ended up with
 * four answers. It is exclusive on the date because an opening balance is the
 * closing balance of the day before the period starts.
 */
async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  const cash = await getCashBalance(companyId, beforeDate, { exclusive: true });
  return cash.total;
}

/**
 * Collapse the period's journals into one signed amount per cash group.
 *
 * Each journal's cash is split by `journalSections`, the rule the indirect statement places the same journal by: only the
 * cash that actually moved is investing or financing (a part bought on account or on a loan in the same journal is not),
 * and the rest is operating. The operating cash is distributed exactly once, over the journal's operating legs, by
 * `apportionBankLeg`'s signed weights. So the two methods always agree on the three section totals.
 */
function groupAllocations(journals: readonly CashFlowJournal[]): Map<CashGroup, number> {
  const totals = new Map<CashGroup, number>();
  const add = (group: CashGroup, amount: number) => { if (amount !== 0) totals.set(group, (totals.get(group) ?? 0) + amount); };
  for (const { legs, netCash, disposal } of journals) {
    const sections = journalSections(legs, netCash, disposal);
    add('investing', sections.investing);
    add('financing', sections.financing);
    if (sections.operating === 0) continue;
    // `ContraLine.amount` is debit less credit; a journal leg carries credit less debit.
    const contras: ContraLine[] = sections.operatingLegs.map((l) => ({ accountType: l.accountType, accountSubtype: l.subtype ?? null, amount: -l.creditLessDebit }));
    // The operating cash stays operating whatever the direct classification says of a leg (accumulated depreciation is
    // an investing account there, but a charge's other leg is an operating add-back in the indirect statement).
    for (const alloc of apportionBankLeg(sections.operating, contras)) {
      add(OPERATING_GROUPS.has(alloc.cashGroup) ? alloc.cashGroup : 'other_operating', alloc.amount);
    }
  }
  return totals;
}

export async function getCashFlowDirect(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CashFlowDirectReport> {
  try {
    // Three reads, not one snapshot (see getIndirectCashFlow): a journal posted by another session between them can show
    // for one load as a small Unexplained Difference; the next load reads both after the posting.
    const [openingCash, journals, ledgerClosing] = await Promise.all([
      fetchOpeningCash(companyId, periodStart),
      fetchCashFlowJournals(companyId, periodStart, periodEnd, { cashJournalsOnly: true }),
      getCashBalance(companyId, periodEnd).then((b) => b.total),
    ]);

    const amountByGroup = groupAllocations(journals);

    // The operating cash of a journal is split pro rata, in fractions of a cent; each line rounds to the cent and the
    // largest line takes the residue, so the lines still add to the exact operating cash (the indirect statement's figure).
    const operatingRaw = OPERATING_ORDER.map((g) => amountByGroup.get(g) ?? 0);
    const operatingCents = operatingRaw.map(toMoney);
    const residue = toMoney(toMoney(operatingRaw.reduce((s, a) => s + a, 0)) - operatingCents.reduce((s, a) => s + a, 0));
    if (residue !== 0) {
      const largest = operatingCents.reduce((best, a, i) => (Math.abs(a) > Math.abs(operatingCents[best]!) ? i : best), 0);
      operatingCents[largest] = toMoney(operatingCents[largest]! + residue);
    }
    const toItem = (group: CashGroup): DirectCashFlowItem => ({
      cashGroup: group,
      label:     CASH_GROUP_LABELS[group],
      amount:    OPERATING_GROUPS.has(group) ? operatingCents[OPERATING_ORDER.indexOf(group)]! : toMoney(amountByGroup.get(group) ?? 0),
    });

    // OPERATING_ORDER is the four members of OPERATING_GROUPS in presentation
    // order; filtering it against that set would never remove anything.
    const operatingItems = OPERATING_ORDER
      .map(toItem)
      .filter((i) => i.amount !== 0);

    const investingItems = [toItem('investing')].filter((i) => i.amount !== 0);
    const financingItems = [toItem('financing')].filter((i) => i.amount !== 0);

    const operatingTotal = toMoney(operatingItems.reduce((s, i) => s + i.amount, 0));
    const investingTotal = toMoney(investingItems.reduce((s, i) => s + i.amount, 0));
    const financingTotal = toMoney(financingItems.reduce((s, i) => s + i.amount, 0));
    const explained = toMoney(operatingTotal + investingTotal + financingTotal);
    // The statement closes on the ledger's cash (`cash.balance.v1`). What the journals' movements do not explain (a cash leg
    // on the year-end closing journal, a posted journal that does not balance) is shown as its own figure, never absorbed:
    // `journalSections` places only what a journal's legs place, so a gap between a journal's cash and its legs is left here,
    // as it is in the indirect statement, and not in an operating line.
    const unexplainedDifference = toMoney(ledgerClosing - openingCash - explained);
    if (unexplainedDifference !== 0) {
      log.warn('Direct cash flow does not tie to the ledger cash',
        { companyId, periodStart, periodEnd, openingCash, explained, ledgerClosing, unexplainedDifference }, 'cash-flow-direct');
    }
    const netChange = toMoney(explained + unexplainedDifference);

    return {
      periodStart,
      periodEnd,
      openingCash,
      operatingItems,
      operatingTotal,
      investingItems,
      investingTotal,
      financingItems,
      financingTotal,
      netChange,
      unexplainedDifference,
      closingCash: toMoney(ledgerClosing),
    };
  } catch (err) {
    // Class and SQLSTATE only: the driver's message can carry SQL and values.
    log.error('Failed to generate direct cash flow', { error: failedReadLabel(err) }, 'accounting');
    throw err;
  }
}
