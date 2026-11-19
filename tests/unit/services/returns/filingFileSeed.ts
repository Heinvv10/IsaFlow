/** Seeded return versions for the filing-file tests (wave 6 EFa): the stored figures as finalise writes them. */
import { buildVat201SarsFields } from '@/modules/accounting/services/reports/vat201SarsFields';
import type { NilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import type { Vat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import type { ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';

const base = {
  postedThrough: '2026-04-02T08:00:00.000Z', sarsSubmissionId: null, filedReference: null, amendsVersionId: null,
  finalisedBy: 'u-admin', finalisedAt: '2026-04-03T09:15:00.000Z', filedBy: null, filedAt: null, amendedBy: null,
  amendReason: null, amendedAt: null, filingFileSha256: null, filingFileKind: null, filingFileAt: null, filingFileBy: null,
} as const;

/**
 * The report's boxes as getVat201Report gives them (what finalise stores as figures.sarsFields): a zero-rated or exempt
 * supply posts no VAT leg, so it is not a box; ordinary and DRC input are both numbered 15; imports are one 14A/15A box.
 */
export const VAT_BOXES = [
  { box: '1', label: 'Standard rated supplies', direction: 'output', vatType: 'standard', base: 100000, tax: 15000 },
  { box: '1A', label: 'Capital goods "sold"', direction: 'output', vatType: 'capital', base: 10000, tax: 1500 },
  { box: '14', label: 'Capital goods', direction: 'input', vatType: 'capital', base: 20000, tax: 3000 },
  { box: '15', label: 'Other goods/services purchased', direction: 'input', vatType: 'standard', base: 23003.33, tax: 3450.5 },
  { box: '15', label: 'Other goods/services purchased (domestic reverse charge)', direction: 'input', vatType: 'reverse_charge', base: 10000, tax: 1500 },
  { box: '14A/15A', label: 'Imported goods', direction: 'input', vatType: 'imported', base: 4000, tax: 600 },
];
export const VAT_TOTALS = { outputTax: 18000, inputTax: 8550.5, netVat: 9449.5 }; // 1500 of output tax on no box of its own: field 12's residual
export const NIL_RATED: NilRatedSupplies = {
  zeroRated: 50000, exported: 12000.25, exempt: 8000, onTaxedJournals: 2500, onTaxedCapital: 0, onTaxedAmbiguous: 0,
  uncodedAssumedZeroRated: 0,
} as NilRatedSupplies;
export const VAT_FORM = buildVat201SarsFields({ boxes: VAT_BOXES, totals: VAT_TOTALS } as unknown as Pick<Vat201Report, 'boxes' | 'totals'>, NIL_RATED);

export const VAT_VERSION: ReturnVersion = {
  ...base, id: '11111111-1111-4111-8111-111111111111', formType: 'VAT201', periodStart: '2026-02-01', periodEnd: '2026-03-31',
  versionNo: 2, status: 'finalised', vatPeriodLockId: '22222222-2222-4222-8222-222222222222',
  // As finalise records it (JSON round trip, as jsonb returns it).
  figures: JSON.parse(JSON.stringify({ ...VAT_TOTALS, sarsFields: VAT_BOXES, sarsForm: VAT_FORM })) as Record<string, unknown>,
};

export const EMP_VERSION: ReturnVersion = {
  ...base, id: '33333333-3333-4333-8333-333333333333', formType: 'EMP201', periodStart: '2026-03-01', periodEnd: '2026-03-31',
  versionNo: 1, status: 'finalised', vatPeriodLockId: null,
  figures: {
    totalPAYE: 41234.56, totalSDL: 2100.1, totalUIF: 1771.24, totalETI: 1500, payePayable: 39234.56,
    etiCarry: { broughtForward: 500, used: 2000, carriedForward: 0, refundClaimable: 0 },
    employeeCount: 9, directivePayments: [], runs: [],
  },
};
