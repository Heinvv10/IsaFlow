/**
 * A 13-week forecast built by the REAL pure engine (runEngine), so the page is tested on the shape the route
 * sends: known lines of every category, an estimate, a budget fill, a manual item, an override, and weeks that
 * go below zero. Today is Monday 2026-11-16.
 */
import { runEngine } from '@/modules/accounting/services/cashForecast13/engine';
import type { CashForecast13, ForecastWarning, KnownItem } from '@/modules/accounting/services/cashForecast13/types';

export const TODAY = '2026-11-16';
export const MANUAL_ID = '11111111-1111-4111-8111-111111111111';

const item = (lineKey: string, lineLabel: string, category: KnownItem['category'], date: string, amountCents: number, extra: Partial<KnownItem> = {}): KnownItem => ({
  lineKey, lineLabel, category, date, amountCents, ref: `${lineKey}:${date}`, refLabel: `${lineLabel} ${date}`, ...extra,
});

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
      item('ar:c1:due', 'Acme Ltd', 'customer_receipts', '2026-11-20', 5_000_00, { basis: 'due', entityId: 'c1' }),
      item('ar:c2:history', 'Beta Traders', 'customer_receipts', '2026-12-01', 3_000_00, { basis: 'history', entityId: 'c2' }),
      item('ar:c3:no_history', 'Gamma CC', 'customer_receipts', '2026-10-01', 1_000_00, { basis: 'no_history', entityId: 'c3' }),
      item('ap:s1', 'Steel Supplies', 'supplier_payments', '2026-11-25', -8_000_00, { entityId: 's1' }),
      item('payroll:net', 'Salaries and wages (net pay)', 'payroll', '2026-11-25', -20_000_00),
      item('sars:emp201', 'SARS EMP201 (PAYE, UIF, SDL)', 'sars', '2026-12-07', -4_000_00, { estimate: true }),
      item('loan:L1', 'Loan repayment: Bank loan', 'loans', '2026-12-01', -2_500_00),
      item('recurring:r1', 'Acme Ltd — Support (recurring)', 'customer_receipts', '2026-12-10', 1_500_00, { entityId: 'c1' }),
    ],
    budget: [{ month: '2026-12', customerReceipts: 100_000_00, supplierPayments: -10_000_00 }],
    manualItems: [{ id: MANUAL_ID, date: '2026-11-30', amountCents: 2_000_00, description: 'Grant payout', category: 'other' }],
    overrides: over.overrides ?? [{ lineKey: 'ap:s1', weekIndex: 1, mode: 'set', amountCents: -6_000_00 }],
    overdueAR: { totalCents: 4_000_00, beyondHorizonCents: 500_00, invoiceCount: 3, byBasis: { history: 3_000_00, no_history: 1_000_00 }, disputedCents: 250_00 },
    warnings: WARNINGS,
  });
}
