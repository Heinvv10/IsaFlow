/**
 * R-089 review round 1, LOW-4: nothing pinned the IMPORTER's use of
 * `deriveSageVat` — only the helper itself was tested. Mutating
 * `importSupplierInvoices` back to the inline `Number(inv.subtotal || 0) ||
 * totalAmount / 1.15` left every other test green (the helper is untouched).
 * This test drives the importer directly with `sql` mocked. Since R-021 the
 * staging row carries no subtotal or tax column at all, so every row takes the
 * not-stated branch; the stated-figure branches are the helper's own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

// R-035 PR2: the import exemption (a set_config pair in a savepoint) is
// covered in r035-pr2-trigger.int.test.ts; here it only wraps the write.
vi.mock('@/modules/accounting/services/gl/approvalGateExempt', () => ({
  assertMayImportOpenBills: async () => undefined,
  withApprovalGateExempt: <T,>(_importer: unknown, write: () => Promise<T>) => write(),
}));
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
    id: runId, runType: 'invoice_import', status: 'completed', totalRecords: total,
    processed: succeeded + failed + skipped, succeeded, failed, skipped,
    startedAt: '', completedAt: null, vatNotStated,
  })),
  failRun: vi.fn(),
  withRunRecovery: (_runId: string, _companyId: string, body: () => Promise<unknown>) => body(),
}));

vi.mock('@/modules/accounting/services/core/migrationPostingSupport', () => ({
  lockMigrationImport: vi.fn(),
}));

vi.mock('@/modules/accounting/services/capture/captureDeduplicationService', () => ({
  computeFingerprint: vi.fn(() => 'fp-1'),
}));

import { importSupplierInvoices } from '@/modules/accounting/services/core/sageSupplierInvoiceImportService';
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
  supplier_name: 'Acme',
  invoice_date: '2026-01-01',
  total_amount: 1150,
};
const supplier = { id: 'sup-1', vat_number: null, payment_terms: 30 };

beforeEach(() => {
  sqlMock.mockReset();
});

describe('importSupplierInvoices — wired to deriveSageVat, never the inline /1.15', () => {
  it('a staged row imports at 0 VAT, subtotal = total, flagged', async () => {
    sqlMock
      .mockResolvedValueOnce([stagedRow]) // SELECT staging
      .mockResolvedValueOnce([supplier]) // SELECT suppliers by name
      .mockResolvedValueOnce([]) // SELECT existing bill by Sage id or number
      .mockResolvedValueOnce([]) // SELECT archived bill (R-101 round 2)
      .mockResolvedValueOnce([{ id: 'new-inv-1' }]) // INSERT ... RETURNING id
      .mockResolvedValueOnce([]); // UPDATE migration_status

    const run = await importSupplierInvoices('company-1', 'user-1');

    const args = findCall('INSERT INTO supplier_invoices');
    // Bound order: company_id, invoice_number, supplier_id, invoice_date,
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

describe('importSupplierInvoices — review round 1 LOW-3: vatNotStated counts only rows that actually import', () => {
  it('a row whose INSERT fails (savepoint rolls back) does not count toward vatNotStated', async () => {
    sqlMock
      .mockResolvedValueOnce([stagedRow]) // SELECT staging
      .mockResolvedValueOnce([supplier]) // SELECT suppliers by name
      .mockResolvedValueOnce([]) // SELECT existing bill by Sage id or number
      .mockResolvedValueOnce([]) // SELECT archived bill (R-101 round 2)
      .mockRejectedValueOnce(new Error('23505 duplicate')) // INSERT throws
      .mockResolvedValueOnce([]); // UPDATE migration_status = 'failed'

    const { completeRun } = await import('@/modules/accounting/services/core/sageMigrationService');
    const run = await importSupplierInvoices('company-1', 'user-1');

    expect(run.failed).toBe(1);
    expect(run.succeeded).toBe(0);
    expect(run.vatNotStated).toBe(0);
    expect(vi.mocked(completeRun)).toHaveBeenCalledWith(
      'run-1', 'company-1', 1, 0, 1, 0, 0,
    );
  });
});
