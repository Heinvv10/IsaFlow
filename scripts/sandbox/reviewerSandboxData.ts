/**
 * Fixtures for the marketplace reviewer sandbox (scripts/sandbox/reviewer-sandbox.ts).
 *
 * EVERYTHING HERE IS FICTIONAL, and obviously so. Every company and party
 * name carries "(Fictional)" or "Demo" (the guard in
 * reviewerSandboxGuards.ts refuses anything else), every email is @example.com,
 * and no SA ID, tax or bank number is stored at all. Do not copy names from
 * scripts/seed-demo-data.ts (real SA company names), scripts/seed-payroll-data.ts
 * (realistic ID and tax numbers) or scripts/qa-seed/parties.ts (names that could
 * belong to real firms).
 *
 * Ids are deterministic so a re-run upserts instead of duplicating. Natural keys
 * (`code`) are what the parties are matched on, following the `notes = code`
 * idempotency trick of scripts/qa-seed/parties.ts.
 */

/** The company name must start with this; guard 1 refuses any other row at the id. */
export const SANDBOX_NAME_PREFIX = 'IsaDemo Reviewer Sandbox';

export const SANDBOX_COMPANY = {
  id: '5a2d0b0e-7e71-4e0a-9a00-000000000001',
  name: `${SANDBOX_NAME_PREFIX} (Fictional)`,
  // Obviously fake: no CIPC number has this shape.
  registrationNumber: 'DEMO/REVIEW/0001',
  // No VAT number at all; 15% VAT on the documents is still computed.
  vatNumber: null as string | null,
  country: 'South Africa',
  currency: 'ZAR',
  /** A non-PAYG plan, so flowMetering never debits and nothing is billed. */
  planCode: 'professional',
} as const;

/**
 * The reviewer's sign-in. The address must be a mailbox Brightsphere controls
 * [VERIFY before --apply]; override with REVIEWER_SANDBOX_EMAIL. Never a
 * personal address.
 */
export const DEFAULT_REVIEWER_EMAIL = 'marketplace-review@isaflow.co.za';
export const REVIEWER_DISPLAY_NAME = 'Demo Marketplace Reviewer';
/** Platform role: the lowest one. Never an admin role. */
export const REVIEWER_PLATFORM_ROLE = 'viewer';
/** Company role: the lowest that passes canWrite (writeRoles.ts), so the payroll tools behind roleFence work. */
export const REVIEWER_COMPANY_ROLE = 'manager';

export const FEATURE_OVERRIDE_REASON = 'Marketplace reviewer sandbox, fictional data';

export interface DemoParty {
  code: string;
  name: string;
  email: string;
}

export const DEMO_CUSTOMERS: readonly DemoParty[] = [
  { code: 'DEMO-C-ALPHA', name: 'Demo Customer Alpha (Fictional)', email: 'alpha@example.com' },
  { code: 'DEMO-C-BRAVO', name: 'Demo Customer Bravo (Fictional)', email: 'bravo@example.com' },
  { code: 'DEMO-C-CHARLIE', name: 'Demo Customer Charlie (Fictional)', email: 'charlie@example.com' },
  { code: 'DEMO-C-DELTA', name: 'Demo Customer Delta (Fictional)', email: 'delta@example.com' },
  { code: 'DEMO-C-ECHO', name: 'Demo Customer Echo (Fictional)', email: 'echo@example.com' },
];

export const DEMO_SUPPLIERS: readonly DemoParty[] = [
  { code: 'DEMO-S-ONE', name: 'Demo Supplier One (Fictional)', email: 'supplier-one@example.com' },
  { code: 'DEMO-S-TWO', name: 'Demo Supplier Two (Fictional)', email: 'supplier-two@example.com' },
  { code: 'DEMO-S-THREE', name: 'Demo Supplier Three (Fictional)', email: 'supplier-three@example.com' },
];

export type DemoInvoiceState = 'paid' | 'unpaid-current' | 'unpaid-over-60';

export interface DemoCustomerInvoice {
  reference: string;
  customerCode: string;
  /** Days before the run date; the document date is computed at run time. */
  issuedDaysAgo: number;
  description: string;
  /** Excl. VAT, rand. VAT is 15% on top, computed by the invoice service. */
  amountExclVat: number;
  state: DemoInvoiceState;
}

/** 8 invoices: 2 paid through receipts, a mix of current and >60-day unpaid, so aged_debtors shows ageing. */
export const DEMO_CUSTOMER_INVOICES: readonly DemoCustomerInvoice[] = [
  { reference: 'DEMO-INV-001', customerCode: 'DEMO-C-ALPHA', issuedDaysAgo: 95, description: 'Demo consulting (fictional)', amountExclVat: 12000, state: 'paid' },
  { reference: 'DEMO-INV-002', customerCode: 'DEMO-C-BRAVO', issuedDaysAgo: 80, description: 'Demo support plan (fictional)', amountExclVat: 4500, state: 'unpaid-over-60' },
  { reference: 'DEMO-INV-003', customerCode: 'DEMO-C-CHARLIE', issuedDaysAgo: 72, description: 'Demo installation (fictional)', amountExclVat: 8800, state: 'unpaid-over-60' },
  { reference: 'DEMO-INV-004', customerCode: 'DEMO-C-DELTA', issuedDaysAgo: 45, description: 'Demo training day (fictional)', amountExclVat: 6200, state: 'paid' },
  { reference: 'DEMO-INV-005', customerCode: 'DEMO-C-ECHO', issuedDaysAgo: 30, description: 'Demo licence (fictional)', amountExclVat: 3100, state: 'unpaid-current' },
  { reference: 'DEMO-INV-006', customerCode: 'DEMO-C-ALPHA', issuedDaysAgo: 20, description: 'Demo consulting (fictional)', amountExclVat: 9600, state: 'unpaid-current' },
  { reference: 'DEMO-INV-007', customerCode: 'DEMO-C-BRAVO', issuedDaysAgo: 12, description: 'Demo hardware (fictional)', amountExclVat: 15400, state: 'unpaid-current' },
  { reference: 'DEMO-INV-008', customerCode: 'DEMO-C-CHARLIE', issuedDaysAgo: 5, description: 'Demo support plan (fictional)', amountExclVat: 4500, state: 'unpaid-current' },
];

export interface DemoSupplierInvoice {
  reference: string;
  supplierCode: string;
  issuedDaysAgo: number;
  description: string;
  amountExclVat: number;
  paid: boolean;
}

/** 4 bills, one left unpaid. */
export const DEMO_SUPPLIER_INVOICES: readonly DemoSupplierInvoice[] = [
  { reference: 'DEMO-BILL-001', supplierCode: 'DEMO-S-ONE', issuedDaysAgo: 60, description: 'Demo office rent (fictional)', amountExclVat: 7000, paid: true },
  { reference: 'DEMO-BILL-002', supplierCode: 'DEMO-S-TWO', issuedDaysAgo: 40, description: 'Demo stationery (fictional)', amountExclVat: 850, paid: true },
  { reference: 'DEMO-BILL-003', supplierCode: 'DEMO-S-THREE', issuedDaysAgo: 25, description: 'Demo software subscription (fictional)', amountExclVat: 1200, paid: true },
  { reference: 'DEMO-BILL-004', supplierCode: 'DEMO-S-ONE', issuedDaysAgo: 10, description: 'Demo office rent (fictional)', amountExclVat: 7000, paid: false },
];

export interface DemoJournal {
  reference: string;
  description: string;
  daysAgo: number;
  /** Codes from the default taxonomy (migration 476), resolved to ids at run time. */
  lines: ReadonlyArray<{ accountCode: string; debit: number; credit: number }>;
}

/** 3 posted journals: an opening balance, a depreciation-style accrual, and a correction. */
export const DEMO_JOURNALS: readonly DemoJournal[] = [
  {
    reference: 'DEMO-JNL-001', description: 'Demo opening balance: equipment funded by share capital (fictional)', daysAgo: 100,
    lines: [{ accountCode: '1210', debit: 25000, credit: 0 }, { accountCode: '3100', debit: 0, credit: 25000 }],
  },
  {
    reference: 'DEMO-JNL-002', description: 'Demo depreciation accrual (fictional)', daysAgo: 31,
    lines: [{ accountCode: '5800', debit: 520.83, credit: 0 }, { accountCode: '1230', debit: 0, credit: 520.83 }],
  },
  {
    reference: 'DEMO-JNL-003', description: 'Demo correction: stationery reclassified to admin (fictional)', daysAgo: 14,
    lines: [{ accountCode: '5600', debit: 200, credit: 0 }, { accountCode: '5100', debit: 0, credit: 200 }],
  },
];

export const DEMO_BANK_ACCOUNT_NAME = 'Demo Bank Cheque (Fictional)';

export interface DemoBankLine {
  reference: string;
  daysAgo: number;
  description: string;
  /** Positive = money in, negative = money out (rand, incl. VAT). */
  amount: number;
}

/** ~15 lines; the unmatched ones give list_bank_transactions and get_match_candidates something to show. */
export const DEMO_BANK_LINES: readonly DemoBankLine[] = [
  { reference: 'DEMO-BANK-01', daysAgo: 90, description: 'Demo opening deposit', amount: 50000 },
  { reference: 'DEMO-BANK-02', daysAgo: 85, description: 'Demo Customer Alpha receipt DEMO-INV-001', amount: 13800 },
  { reference: 'DEMO-BANK-03', daysAgo: 58, description: 'Demo Supplier One payment DEMO-BILL-001', amount: -8050 },
  { reference: 'DEMO-BANK-04', daysAgo: 50, description: 'Demo bank fees', amount: -145 },
  { reference: 'DEMO-BANK-05', daysAgo: 38, description: 'Demo Supplier Two payment DEMO-BILL-002', amount: -977.5 },
  { reference: 'DEMO-BANK-06', daysAgo: 35, description: 'Demo Customer Delta receipt DEMO-INV-004', amount: 7130 },
  { reference: 'DEMO-BANK-07', daysAgo: 30, description: 'Demo payroll transfer', amount: -42000 },
  { reference: 'DEMO-BANK-08', daysAgo: 24, description: 'Demo Supplier Three payment DEMO-BILL-003', amount: -1380 },
  { reference: 'DEMO-BANK-09', daysAgo: 20, description: 'Demo bank fees', amount: -145 },
  { reference: 'DEMO-BANK-10', daysAgo: 15, description: 'Demo unidentified deposit', amount: 2500 },
  { reference: 'DEMO-BANK-11', daysAgo: 12, description: 'Demo card purchase (fictional cafe)', amount: -320 },
  { reference: 'DEMO-BANK-12', daysAgo: 9, description: 'Demo partial receipt Bravo', amount: 2000 },
  { reference: 'DEMO-BANK-13', daysAgo: 6, description: 'Demo fuel (fictional garage)', amount: -650 },
  { reference: 'DEMO-BANK-14', daysAgo: 3, description: 'Demo interest received', amount: 42.18 },
  { reference: 'DEMO-BANK-15', daysAgo: 1, description: 'Demo unidentified debit order', amount: -499 },
];

// Payroll (3 "Demo Employee" records and a finalised pay run) is not seeded
// yet; see the PR's "Left out". When it is, employees carry NO ID number, tax
// number or bank details (payroll_employees allows all three to be NULL).

/** Every name the script will write, for the fictional-name guard. */
export function allSandboxNames(): string[] {
  return [
    SANDBOX_COMPANY.name,
    REVIEWER_DISPLAY_NAME,
    DEMO_BANK_ACCOUNT_NAME,
    ...DEMO_CUSTOMERS.map((p) => p.name),
    ...DEMO_SUPPLIERS.map((p) => p.name),
  ];
}
