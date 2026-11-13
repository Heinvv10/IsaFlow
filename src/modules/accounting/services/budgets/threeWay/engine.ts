/**
 * runThreeWay (P6 spec §5, §13; T5): the budgeted P&L of one version projected
 * into a balance sheet and cash flow per month. Pure and deterministic: no DB,
 * no clock; integer cents; double entry (every posting asserts Σdr = Σcr).
 *
 * Per month, in spec order: 1 sales (+ other income) · 2 receipts (days
 * method) · 3 cost of sales out of inventory · 4 supplier purchases and
 * payments (days method) · 5 payroll and the EMP201 remittance of the liability
 * held at the start of the month · 6 depreciation · 7 finance cost, loan
 * drawdowns and principal · 8 capex · 9 income tax accrual and provisional
 * payments · 10 equity · 11 VAT settlement.
 *
 * Receipts, payments and stock purchases are RESIDUALS of the closing balance
 * the days method gives, so AR/AP/inventory always tie and rounding can never
 * unbalance. The opening must balance within 1 cent (`OpeningUnbalancedError`
 * beyond that; a 1-cent difference is carried to retained earnings and warned).
 * Negative cash is shown, never funded (10d).
 */
import { balanceSheetSections, bucketSum } from './balanceSheet';
import { cashFlowMonth, netProfit, runwayOf } from './cashFlow';
import { closingFromDays, walksPastStart } from './daysMethod';
import { planEvents } from './engineEvents';
import { ratesOf, validateEngineInput, type EngineRates } from './engineInput';
import { OpeningUnbalancedError } from './errors';
import { addMonths, daysInMonth } from './months';
import * as P from './postings';
import { vatInGross, vatOnNet } from './ratios';
import { payrollSplit } from './statutorySchedule';
import type { Buckets, EngineInput, EngineOutput, MonthResult, Posting, ThreeWayWarning } from './types';
import { VatBook } from './vatBook';

/** Flow series over lookback + version months (oldest first), for the days method. */
interface Series { days: number[]; salesIncl: number[]; cogs: number[]; purchasesIncl: number[] }

function seriesOf(input: EngineInput, r: EngineRates): Series {
  const lb = input.lookback;
  return {
    days: [...lb.map(l => daysInMonth(l.month)), ...input.months.map(daysInMonth)],
    salesIncl: [...lb.map(l => l.turnover + vatOnNet(l.turnover, r.salesSharePpm)),
      ...input.pnl.map(p => p.turnover + vatOnNet(p.turnover, r.salesSharePpm))],
    cogs: [...lb.map(l => l.costOfSales), ...input.pnl.map(p => p.costOfSales)],
    // Version months are filled in the loop (stock purchases depend on closing inventory).
    purchasesIncl: [...lb.map(l => l.supplierPurchases + vatOnNet(l.supplierPurchases, r.purchasesSharePpm)), ...input.months.map(() => 0)],
  };
}

function openingOf(input: EngineInput, warnings: ThreeWayWarning[]): Buckets {
  const b = { ...input.opening.buckets };
  const diff = bucketSum(b);
  if (Math.abs(diff) > 1) throw new OpeningUnbalancedError(diff);
  if (diff !== 0) {
    b.retainedEarnings -= diff;
    warnings.push({ code: 'opening_cent_difference', cents: diff });
  }
  if (input.opening.provisional) warnings.push({ code: 'opening_provisional', asAt: input.opening.asAt });
  const unmapped = (input.opening.unmapped ?? []).filter(u => u.balance !== 0);
  if (unmapped.length > 0) warnings.push({ code: 'unmapped_balance', accounts: [...unmapped] });
  return b;
}

/** The VAT book, seeded with the opening VAT control's due part (payment basis: less the VAT still inside opening AR/AP). */
function vatBookOf(input: EngineInput, a: EngineInput['assumptions'], r: EngineRates, open: Buckets): VatBook | null {
  if (!r.registered) return null;
  const first = input.months[0] as string;
  const book = new VatBook(a.vat.cadence.value, a.vat.alignment.value, r.refundLagMonths, first);
  let due = -open.vatControl;
  if (r.paymentBasis) due += -vatInGross(open.receivables, r.salesSharePpm) + vatInGross(-open.payables, r.purchasesSharePpm);
  book.accrue(addMonths(first, -1), due);
  return book;
}

export function runThreeWay(input: EngineInput): EngineOutput {
  const a = validateEngineInput(input);
  const r = ratesOf(a);
  const warnings: ThreeWayWarning[] = [];
  const opening = openingOf(input, warnings);
  const planned = planEvents(input, a, r);
  const s = seriesOf(input, r);
  const L = input.lookback.length;
  const vat = vatBookOf(input, a, r, opening);
  const short = { receivables: [] as string[], payables: [] as string[], inventory: [] as string[] };

  const b: Buckets = { ...opening };
  const postings: Posting[] = [];
  const results: MonthResult[] = [];

  input.months.forEach((m, i) => {
    const p = input.pnl[i] as (typeof input.pnl)[number];
    const ev = planned.byMonth.get(m);
    const open: Buckets = { ...b };
    const month: Posting[] = [];
    const add = (x: Posting) => { month.push(x); P.applyPosting(b, x); };
    const k = L + i;
    if (r.debtorDays > 0 && walksPastStart(r.debtorDays, s.days, k)) short.receivables.push(m);
    if (r.creditorDays > 0 && walksPastStart(r.creditorDays, s.days, k)) short.payables.push(m);
    if (r.inventoryDays > 0 && walksPastStart(r.inventoryDays, s.days, k)) short.inventory.push(m);

    // 1. Sales and other income.
    const outputVat = (s.salesIncl[k] as number) - p.turnover;
    add(P.salesPosting(m, p.turnover, outputVat));
    add(P.otherIncomePosting(m, p.otherIncome));
    // 2. Receipts = the residual that leaves AR at its days-method closing.
    const receipts = b.receivables - closingFromDays(r.debtorDays, s.salesIncl, s.days, k);
    add(P.receiptsPosting(m, receipts));
    // 3. Cost of sales; stock purchases = the residual that leaves inventory at its closing.
    const stockPurchases = p.costOfSales + closingFromDays(r.inventoryDays, s.cogs, s.days, k) - open.inventory;
    add(P.cogsPosting(m, p.costOfSales));
    // 4. Supplier purchases (stock + opex) and payments.
    const purchasesEx = stockPurchases + p.otherOpex;
    const inputVat = vatOnNet(purchasesEx, r.purchasesSharePpm);
    s.purchasesIncl[k] = purchasesEx + inputVat;
    add(P.purchasesPosting(m, stockPurchases, p.otherOpex, inputVat));
    const payments = -b.payables - closingFromDays(r.creditorDays, s.purchasesIncl, s.days, k);
    add(P.supplierPaymentsPosting(m, payments));
    // 5. EMP201: remit what was owed at the start of the month; accrue this month's statutory share.
    add(P.payrollRemittancePosting(m, -open.payrollLiabilities));
    const pay = payrollSplit(p.payroll, r.statutorySharePpm);
    add(P.payrollPosting(m, p.payroll, pay.net, pay.statutory));
    // 6. Depreciation (non-cash).
    add(P.depreciationPosting(m, p.depreciation));
    // 7. Finance cost paid in the month; loans.
    add(P.financeCostPosting(m, p.financeCost));
    for (const d of ev?.drawdowns ?? []) add(P.loanDrawdownPosting(m, d));
    add(P.loanPrincipalPosting(m, ev?.principal ?? 0));
    // 8. Capex, paid in its month.
    let capexVat = 0;
    for (const c of ev?.capex ?? []) {
      add(P.capexPosting(m, c.exVat, c.vat));
      capexVat += c.vat;
    }
    // 9. Income tax.
    add(P.incomeTaxPosting(m, p.taxExpense));
    for (const t of ev?.tax ?? []) add(P.provisionalTaxPosting(m, t.amount));
    // 10. Equity.
    for (const x of ev?.shareIssues ?? []) add(P.shareIssuePosting(m, x));
    for (const x of ev?.dividendsDeclared ?? []) add(P.dividendDeclaredPosting(m, x));
    for (const x of ev?.dividendsPaid ?? []) add(P.dividendPaidPosting(m, x));
    // 11. VAT: accrue the month's net on the company's basis, then settle what falls due.
    if (vat) {
      const net = r.paymentBasis
        ? vatInGross(receipts, r.salesSharePpm) - vatInGross(payments, r.purchasesSharePpm) - capexVat
        : outputVat - inputVat - capexVat;
      vat.accrue(m, net);
      for (const due of vat.settle(m)) add(P.vatSettlementPosting(m, due));
    }

    postings.push(...month);
    const closing: Buckets = { ...b };
    results.push({
      month: m,
      pnl: { ...p, netProfit: netProfit(p) },
      closing,
      balanceSheet: balanceSheetSections(closing),
      cashFlow: cashFlowMonth(open, closing, month, p, capexVat),
    });
  });

  for (const series of ['receivables', 'payables', 'inventory'] as const) {
    if (short[series].length > 0) warnings.push({ code: 'lookback_short', series, months: short[series] });
  }
  const negative = results.filter(x => x.closing.cash < 0).map(x => x.month);
  if (negative.length > 0) warnings.push({ code: 'negative_cash', months: negative });

  const months = input.months;
  return {
    months: results,
    opening: { asAt: input.opening.asAt, provisional: input.opening.provisional, buckets: opening, balanceSheet: balanceSheetSections(opening) },
    postings,
    runway: runwayOf(results, a.minimumCash.value),
    warnings: [...warnings, ...planned.warnings],
    vatSettlements: vat ? vat.settlements() : [],
    taxEvents: planned.taxEvents,
    fiscal: {
      yearEnd: months[months.length - 1] as string,
      priorYearEnd: addMonths(months[0] as string, -1),
      fyMonthIndex: months.map((_, i) => i + 1),
    },
  };
}
