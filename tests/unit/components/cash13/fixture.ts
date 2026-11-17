/**
 * A 13-week forecast built by the REAL pure engine (arItems, overdueSummary, runEngine), so the page is tested on
 * the shape the route sends: known lines of every category, an estimate, a budget fill, a manual item, an override, and weeks that
 * go below zero. Today is Monday 2026-11-16.
 */
import { runEngine } from '@/modules/accounting/services/cashForecast13/engine';
import { arItems, overdueSummary, type OpenArInvoice } from '@/modules/accounting/services/cashForecast13/arExpected';
import { buildWeeks } from '@/modules/accounting/services/cashForecast13/weeks';
import type { CashForecast13, ForecastWarning, KnownItem } from '@/modules/accounting/services/cashForecast13/types';

export const TODAY = '2026-11-16';
export const MANUAL_ID = '11111111-1111-4111-8111-111111111111';

const item = (lineKey: string, lineLabel: string, category: KnownItem['category'], date: string, amountCents: number, extra: Partial<KnownItem> = {}): KnownItem => ({
  lineKey, lineLabel, category, date, amountCents, ref: `${lineKey}:${date}`, refLabel: `${lineLabel} ${date}`, ...extra,
});

const HORIZON_END = buildWeeks(TODAY).at(-1)!.end;

const inv = (id: string, customerId: string, customerName: string, dueDate: string, balanceCents: number, disputedCents = 0): OpenArInvoice => ({
  id, invoiceNumber: `INV-${id}`, customerId, customerName, dueDate, balanceCents, disputedCents,
});

/**
 * Open customer invoices dated by the engine's own `arItems` (one line per customer, `basisCents`, the
 * `no_history` flag) and summarised by its `overdueSummary`:
 *   Acme: due 5 000 (not yet due) + 1 200 overdue with history; Beta: 3 000 overdue with history (250 disputed);
 *   Gamma: 1 000 overdue, no history; Delta: 500 whose history puts it after week 13.
 */
const ar = arItems([
  inv('a1', 'c1', 'Acme Ltd', '2026-11-20', 5_000_00),
  inv('a2', 'c1', 'Acme Ltd', '2026-11-02', 1_200_00),
  inv('b1', 'c2', 'Beta Traders', '2026-11-10', 3_250_00, 250_00),
  inv('g1', 'c3', 'Gamma CC', '2026-10-01', 1_000_00),
  inv('d1', 'c4', 'Delta Late', '2026-11-01', 500_00),
], new Map([['c1', [10, 10, 10]], ['c2', [21, 21, 21]], ['c4', [200, 200, 200]]]), TODAY);

export const WARNINGS: ForecastWarning[] = [
  { code: 'credit_unused', source: 'customer invoices', message: 'customer invoices: R 1 200.00 of unapplied credit across 2 account(s) exceeds their expected documents and is ignored' },
  { code: 'source_unavailable', source: 'loans', message: 'loans could not be read; the forecast leaves it out' },
  { code: 'currency_not_converted', source: 'supplier invoices', message: 'Supplier invoices in USD have no stored exchange rate and are left out: INV-9' },
  { code: 'sars_past_due_assumed_paid', source: 'sars', message: '1 SARS item(s) due before today and not marked filed are assumed paid (in opening cash): EMP201 2026-10-01..2026-10-31 due 2026-11-07 R 4 000.00' },
  { code: 'mystery_code_xyz', source: 'engine', message: 'Something new the page has no words for yet' },
];

export function forecastFixture(over: { openingCents?: number; overrides?: Parameters<typeof runEngine>[0]['overrides'] } = {}): CashForecast13 {
  return runEngine({
    today: TODAY,
    openingCents: over.openingCents ?? 10_000_00,
    items: [
      ...ar.items,
      item('ap:s1', 'Steel Supplies', 'supplier_payments', '2026-11-25', -8_000_00, { entityId: 's1' }),
      item('payroll:net', 'Salaries and wages (net pay)', 'payroll', '2026-11-25', -20_000_00),
      item('sars:emp201', 'SARS EMP201 (PAYE, UIF, SDL)', 'sars', '2026-12-07', -4_000_00, { estimate: true }),
      item('loan:L1', 'Loan repayment: Bank loan', 'loans', '2026-12-01', -2_500_00),
      item('recurring:r1', 'Acme Ltd — Support (recurring)', 'customer_receipts', '2026-12-10', 1_500_00, { entityId: 'c1' }),
    ],
    budget: [{ month: '2026-12', customerReceipts: 100_000_00, supplierPayments: -10_000_00 }],
    manualItems: [{ id: MANUAL_ID, date: '2026-11-30', amountCents: 2_000_00, description: 'Grant payout', category: 'other' }],
    overrides: over.overrides ?? [{ lineKey: 'ap:s1', weekIndex: 1, mode: 'set', amountCents: -6_000_00 }],
    overdueAR: overdueSummary(ar.items, ar.disputedCents, HORIZON_END),
    warnings: WARNINGS,
  });
}
