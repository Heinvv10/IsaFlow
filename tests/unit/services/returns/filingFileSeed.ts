/** Seeded return versions for the filing-file tests (wave 6 EFa): the stored figures as finalise writes them. */
import type { ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';

const base = {
  postedThrough: '2026-04-02T08:00:00.000Z', sarsSubmissionId: null, filedReference: null, amendsVersionId: null,
  finalisedBy: 'u-admin', finalisedAt: '2026-04-03T09:15:00.000Z', filedBy: null, filedAt: null, amendedBy: null,
  amendReason: null, amendedAt: null, filingFileSha256: null, filingFileKind: null, filingFileAt: null, filingFileBy: null,
} as const;

export const VAT_VERSION: ReturnVersion = {
  ...base, id: '11111111-1111-4111-8111-111111111111', formType: 'VAT201', periodStart: '2026-02-01', periodEnd: '2026-03-31',
  versionNo: 2, status: 'finalised', vatPeriodLockId: '22222222-2222-4222-8222-222222222222',
  figures: {
    outputTax: 15000, inputTax: 6450.5, netVat: 8549.5,
    sarsFields: [
      { box: '1', label: 'Standard rate (excl. capital goods)', direction: 'output', vatType: 'standard', base: 100000, tax: 15000 },
      { box: '2', label: 'Zero rate, "excluding" exports', direction: 'output', vatType: 'zero_rated', base: 2500.25, tax: 0 },
      { box: '14', label: 'Capital goods', direction: 'input', vatType: 'capital', base: 20000, tax: 3000 },
      { box: '15', label: '=Other goods and services', direction: 'input', vatType: 'standard', base: 23003.33, tax: 3450.5 },
    ],
  },
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
