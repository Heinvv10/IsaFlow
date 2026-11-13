/**
 * The three-way assumptions document (P6 spec §4), `schemaVersion: 1`.
 *
 * One validated document per version. Every scalar carries provenance
 * (`Prov`: derived from actuals or entered by hand). Money is integer CENTS
 * (`amountExVat`, `principal`, `amount`, `minimumCash`; each ≤ MAX_VALUE_CENTS);
 * months are 'YYYY-MM'; day counts take at most 2 decimals.
 *
 * A scenario version stores `{ schemaVersion: 1, overrides }` instead: a sparse
 * override whose sections are partial but whose `Prov` values and lists are
 * whole (`assumptionsChain.ts` merges it; lists REPLACE, never element-merge).
 * Unknown keys are refused everywhere (strict objects), so a typo is a 400,
 * never a silently ignored field.
 */
import { z } from 'zod';
import { MAX_VALUE_CENTS } from './ratios';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const Month = z.string().regex(MONTH_PATTERN, "Month must be 'YYYY-MM'");
const IsoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Date must be 'YYYY-MM-DD'");
const Id = z.string().min(1).max(64);
const Text = z.string().max(200);
/** Cents, within the engine's per-value cap (MAX_VALUE_CENTS, 1e13). */
const Cents = z.number().int().min(-MAX_VALUE_CENTS).max(MAX_VALUE_CENTS);
const PositiveCents = z.number().int().min(1).max(MAX_VALUE_CENTS);
const NonNegativeCents = z.number().int().min(0).max(MAX_VALUE_CENTS);
/** Days to at most 2 decimals (the engine computes in hundredths of a day, exactly). */
const Days = (max: number) => z.number().min(0).max(max)
  .refine(d => Math.abs(d * 100 - Math.round(d * 100)) < 1e-6, { message: 'Days take at most 2 decimals' });
const Share = z.number().min(0).max(1);
/** Up to 5 years of lists per kind: far beyond a 15-month version, small enough to bound a request. */
export const MAX_LIST_ITEMS = 200;

export const ProvenanceSource = z.enum(['derived', 'manual']);

/** `{ value, source, derivedAsAt?, basis? }` around a value schema. */
export function prov<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    source: ProvenanceSource,
    derivedAsAt: IsoDate.optional(),
    basis: Text.optional(),
  }).strict();
}

export const WorkingCapitalSchema = z.object({
  debtorDays: prov(Days(365)),
  creditorDays: prov(Days(365)),
  inventoryDays: prov(Days(730)),
}).strict();

export const VatAssumptionsSchema = z.object({
  registered: prov(z.boolean()),
  cadence: prov(z.enum(['monthly', 'bi-monthly'])),
  alignment: prov(z.enum(['odd', 'even'])),
  basis: prov(z.enum(['invoice', 'payment'])),
  vatableSalesShare: prov(Share),
  vatablePurchasesShare: prov(Share),
  refundLagMonths: prov(z.union([z.literal(0), z.literal(1), z.literal(2)])),
}).strict();

export const PayrollAssumptionsSchema = z.object({ statutoryShare: prov(Share) }).strict();

/** A GL account id (the DB service checks it is a leaf liability of the company). */
const AccountId = z.guid('Must be an account id');

export const IncomeTaxAssumptionsSchema = z.object({
  mode: prov(z.enum(['provisional', 'off'])),
  topUpMonthOffset: prov(z.union([z.literal(6), z.literal(7)])),
  /** The liability account holding income tax payable (spec §5): its opening balance is `incomeTaxPayable`. Absent = synthetic line. */
  payableAccountId: AccountId.optional(),
}).strict();

const CapexItem = z.object({
  id: Id, month: Month, amountExVat: NonNegativeCents, vatClaimable: z.boolean(),
  description: Text, usefulLifeYears: z.number().int().min(1).max(100).optional(),
}).strict();

const ExistingLoan = z.object({ loanId: Id, include: z.boolean() }).strict();
const PlannedLoan = z.object({
  id: Id, description: Text, drawdownMonth: Month, principal: PositiveCents,
  annualRatePct: z.number().min(0).max(100), termMonths: z.number().int().min(1).max(600), firstRepaymentMonth: Month,
}).strict().refine(l => l.firstRepaymentMonth >= l.drawdownMonth, {
  message: 'firstRepaymentMonth must not be before drawdownMonth', path: ['firstRepaymentMonth'],
});

const ShareIssue = z.object({ id: Id, month: Month, amount: PositiveCents }).strict();
const Dividend = z.object({ id: Id, declaredMonth: Month, paidMonth: Month, amount: PositiveCents }).strict()
  .refine(d => d.paidMonth >= d.declaredMonth, { message: 'paidMonth must not be before declaredMonth', path: ['paidMonth'] });

/** A list whose `key` values are unique (an id names one entry). */
function uniqueList<T extends z.ZodType>(item: T, key: (v: z.infer<T>) => string) {
  return z.array(item).max(MAX_LIST_ITEMS).superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((v, i) => {
      const k = key(v);
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `Duplicate id ${k}`, path: [i] });
      seen.add(k);
    });
  });
}

export const CapexListSchema = uniqueList(CapexItem, c => c.id);
export const LoansAssumptionsSchema = z.object({
  existing: uniqueList(ExistingLoan, l => l.loanId),
  planned: uniqueList(PlannedLoan, l => l.id),
}).strict();
export const EquityAssumptionsSchema = z.object({
  shareIssues: uniqueList(ShareIssue, s => s.id),
  dividends: uniqueList(Dividend, d => d.id),
  /** The liability account holding dividends payable (spec §5): its opening balance is `dividendsPayable`. Absent = synthetic line. */
  dividendsPayableAccountId: AccountId.optional(),
}).strict();
const MinimumCash = prov(Cents);

export const ThreeWayAssumptionsSchema = z.object({
  schemaVersion: z.literal(1),
  workingCapital: WorkingCapitalSchema,
  vat: VatAssumptionsSchema,
  payroll: PayrollAssumptionsSchema,
  incomeTax: IncomeTaxAssumptionsSchema,
  capex: CapexListSchema,
  loans: LoansAssumptionsSchema,
  equity: EquityAssumptionsSchema,
  minimumCash: MinimumCash,
}).strict();

/** Sparse scenario overrides: sections partial, `Prov` values and lists whole. */
export const AssumptionOverridesSchema = z.object({
  workingCapital: WorkingCapitalSchema.partial().optional(),
  vat: VatAssumptionsSchema.partial().optional(),
  payroll: PayrollAssumptionsSchema.partial().optional(),
  incomeTax: IncomeTaxAssumptionsSchema.partial().optional(),
  capex: CapexListSchema.optional(),
  loans: LoansAssumptionsSchema.partial().optional(),
  equity: EquityAssumptionsSchema.partial().optional(),
  minimumCash: MinimumCash.optional(),
}).strict();

export const ScenarioOverridesDocSchema = z.object({
  schemaVersion: z.literal(1),
  overrides: AssumptionOverridesSchema,
}).strict();

/** What a version stores: a full document, or (scenarios) overrides of its base. */
export const StoredAssumptionsDocSchema = z.union([ThreeWayAssumptionsSchema, ScenarioOverridesDocSchema]);

export type Prov<T> = { value: T; source: 'derived' | 'manual'; derivedAsAt?: string; basis?: string };
export type ThreeWayAssumptions = z.infer<typeof ThreeWayAssumptionsSchema>;
export type AssumptionOverrides = z.infer<typeof AssumptionOverridesSchema>;
export type ScenarioOverridesDoc = z.infer<typeof ScenarioOverridesDocSchema>;
export type StoredAssumptionsDoc = z.infer<typeof StoredAssumptionsDocSchema>;
export type CapexItem = ThreeWayAssumptions['capex'][number];
export type PlannedLoan = ThreeWayAssumptions['loans']['planned'][number];

/** A full document (as opposed to scenario overrides). */
export function isFullDoc(doc: StoredAssumptionsDoc): doc is ThreeWayAssumptions {
  return !('overrides' in doc);
}
