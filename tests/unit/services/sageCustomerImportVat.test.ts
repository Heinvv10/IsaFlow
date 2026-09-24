/**
 * R-089 review round 1, LOW-4: the customer-side twin of the supplier
 * importer test — drives `importCustomerInvoices` with `sql` mocked so a
 * regression back to the inline `/1.15` derivation is caught here, not only
 * in the `deriveSageVat` unit tests. CI does not run the integration suites,
 * so this is the gate that does run. Since R-101 the staging row carries no
 * subtotal or tax column, so every row takes the not-stated branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(sqlMock, { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/core/sageMigrationService', () => ({
  startRun: vi.fn().mockResolvedValue('run-1'),
  completeRun: vi.fn((
    runId: string, _companyId: string, total: number, succeeded: number, failed: number, skipped: number, vatNotStated = 0,
  ) => Promise.resolve({
    id: runId, runType: 'customer_invoice_import', status: 'completed', totalRecords: total,
    processed: succeeded + failed + skipped, succeeded, failed, skipped,
    startedAt: '', completedAt: null, vatNotStated,
  })),
  failRun: vi.fn(),
  withRunRecovery: (_runId: string, _companyId: string, body: () => Promise<unknown>) => body(),
}));

vi.mock('@/modules/accounting/services/core/migrationPostingSupport', () => ({
  lockMigrationImport: vi.fn(),
}));

import { importCustomerInvoices } from '@/modules/accounting/services/core/sageCustomerImportService';
import { SAGE_VAT_NOT_STATED_NOTE } from '@/modules/accounting/services/shared/sageVatDerivation';

/** Find the args of the call whose SQL text contains `needle`. */
function findCall(needle: string): unknown[] {
  const call = sqlMock.mock.calls.find((c) => {
    const strings = c[0] as TemplateStringsArray | string[];
    return Array.isArray(strings) && strings.join('').includes(needle);
  });
  if (!call) throw new Error(`No sql call found containing: ${needle}`);
  return call.slice(1);
}

const stagedRow = {
  id: 'stg-1',
  sage_id: 'SAGE-1',
  invoice_number: 'INV-1',
  customer_name: 'Acme',
  invoice_date: '2026-01-01',
  total_amount: 1150,
};
const customer = { id: 'cust-1', payment_terms: 30 };

beforeEach(() => {
  sqlMock.mockReset();
});

describe('importCustomerInvoices — wired to deriveSageVat, never the inline /1.15', () => {
  it('a staged row imports at 0 VAT, subtotal = total, flagged', async () => {
    sqlMock
      .mockResolvedValueOnce([stagedRow]) // SELECT staging
      .mockResolvedValueOnce([customer]) // SELECT customers by name
      .mockResolvedValueOnce([]) // SELECT existing invoice by Sage id or number
      .mockResolvedValueOnce([{ id: 'new-inv-1' }]) // INSERT ... RETURNING id
      .mockResolvedValueOnce([]); // UPDATE migration_status

    const run = await importCustomerInvoices('company-1', 'user-1');

    const args = findCall('INSERT INTO customer_invoices');
    // Bound order: company_id, invoice_number, customer_id, invoice_date,
    // invoice_date (due base), payment_terms, subtotal, tax_rate, tax_amount, total, ...
    expect(args[6]).toBe('1150.00');
    expect(args[7]).toBe(0);
    expect(args[8]).toBe('0.00');
    // The old defect: subtotal 1000.00, taxAmount 150.00.
    expect(args[6]).not.toBe('1000.00');
    expect(args[8]).not.toBe('150.00');
    expect(args).toContain(SAGE_VAT_NOT_STATED_NOTE);
    expect(run.vatNotStated).toBe(1);
  });
});

describe('importCustomerInvoices — review round 1 LOW-3: vatNotStated counts only rows that actually import', () => {
  it('a row whose INSERT fails (savepoint rolls back) does not count toward vatNotStated', async () => {
    sqlMock
      .mockResolvedValueOnce([stagedRow]) // SELECT staging
      .mockResolvedValueOnce([customer]) // SELECT customers by name
      .mockResolvedValueOnce([]) // SELECT existing invoice by Sage id or number
      .mockRejectedValueOnce(new Error('23505 duplicate')) // INSERT throws
      .mockResolvedValueOnce([]); // UPDATE migration_status = 'failed'

    const { completeRun } = await import('@/modules/accounting/services/core/sageMigrationService');
    const run = await importCustomerInvoices('company-1', 'user-1');

    expect(run.failed).toBe(1);
    expect(run.succeeded).toBe(0);
    expect(run.vatNotStated).toBe(0);
    expect(vi.mocked(completeRun)).toHaveBeenCalledWith(
      'run-1', 'company-1', 1, 0, 1, 0, 0,
    );
  });
});
