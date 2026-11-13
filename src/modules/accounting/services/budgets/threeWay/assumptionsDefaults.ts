/**
 * The fallback assumptions document (spec §4 "Derived defaults" when there is
 * no history): debtor/creditor days 30, inventory days 0 (`basis: 'insufficient
 * history'`), shares 1, refund lag 1, statutory share 0, provisional tax on for
 * companies (§13.2) with the SARS top-up offset from the prior year end, empty
 * lists, minimum cash 0. Every value is `source: 'derived'`.
 *
 * The derive service (PR C, `deriveAssumptions`) starts here and replaces each
 * value it can compute from actuals. VAT settings come from the company row via
 * `vatPeriodHelper`'s normalisers (the caller passes them already normalised).
 */
import type { EntityTypeCode } from '@/lib/entityTypes';
import type { Prov, ThreeWayAssumptions } from './assumptionsSchema';
import { provisionalTaxApplies, sarsTopUpOffset } from './statutorySchedule';
import type { VatAlignment, VatCadence } from './vatSchedule';

export interface DefaultAssumptionOptions {
  /** The month before the version's first month ('YYYY-MM'). */
  priorYearEnd: string;
  entityType: EntityTypeCode;
  vat: { registered: boolean; cadence: VatCadence; alignment: VatAlignment; basis: 'invoice' | 'payment' };
  /** 'YYYY-MM-DD' stamped as `derivedAsAt` when given. */
  asAt?: string;
}

export function defaultAssumptions(o: DefaultAssumptionOptions): ThreeWayAssumptions {
  const d = <T>(value: T, basis = 'default'): Prov<T> =>
    (o.asAt ? { value, source: 'derived', derivedAsAt: o.asAt, basis } : { value, source: 'derived', basis });
  return {
    schemaVersion: 1,
    workingCapital: {
      debtorDays: d(30, 'insufficient history'),
      creditorDays: d(30, 'insufficient history'),
      inventoryDays: d(0, 'insufficient history'),
    },
    vat: {
      registered: d(o.vat.registered, 'company VAT settings'),
      cadence: d(o.vat.cadence, 'company VAT settings'),
      alignment: d(o.vat.alignment, 'company VAT settings'),
      basis: d(o.vat.basis, 'company VAT settings'),
      vatableSalesShare: d(1),
      vatablePurchasesShare: d(1),
      refundLagMonths: d<0 | 1 | 2>(1),
    },
    payroll: { statutoryShare: d(0) },
    incomeTax: {
      mode: d<'provisional' | 'off'>(provisionalTaxApplies(o.entityType) ? 'provisional' : 'off', 'entity type'),
      topUpMonthOffset: d(sarsTopUpOffset(o.priorYearEnd), 'SARS: 7 months after a February year end, else 6'),
    },
    capex: [],
    loans: { existing: [], planned: [] },
    equity: { shareIssues: [], dividends: [] },
    minimumCash: d(0),
  };
}
