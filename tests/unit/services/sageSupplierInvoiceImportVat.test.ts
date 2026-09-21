/**
 * R-089 review round 1, LOW-4: nothing pinned the IMPORTER's use of
 * `deriveSageVat` — only the helper itself was tested. Mutating
 * `importSupplierInvoices` back to the inline `Number(inv.subtotal || 0) ||
 * totalAmount / 1.15` left every other test green (the helper is untouched).
 * This test drives the importer directly with `sql` mocked, so once R-021 or
 * the customer twin makes the real SELECT run, a regression here is caught
 * before it reaches the DB.
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
    runId: string, total: number, succeeded: number, failed: number, skipped: number, vatNotStated = 0,
  ) => Promise.resolve({
    id: runId, runType: 'invoice_import', status: 'completed', totalRecords: total,
    processed: succeeded + failed + skipped, succeeded, failed, skipped,
    startedAt: '', completedAt: null, vatNotStated,
  })),
  failRun: vi.fn(),
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

const baseRow = {
  id: 'stg-1',
  sage_invoice_id: 'SAGE-1',
  sage_supplier_id: 'sup-sage-1',
  invoice_number: 'INV-1',
  invoice_date: '2026-01-01',
  due_date: null,
  total_amount: 1150,
  outstanding_amount: null,
  status: null,
  ff_purchase_order_id: null,
  supplier_id: 'sup-1',
  raw_data: null,
  line_items: null,
};

beforeEach(() => {
  sqlMock.mockReset();
});

describe('importSupplierInvoices — wired to deriveSageVat, never the inline /1.15', () => {
  it('a row with no subtotal and no tax imports at 0 VAT, subtotal = total', async () => {
    sqlMock
      .mockResolvedValueOnce([{ ...baseRow, subtotal: null, tax_amount: null }]) // SELECT sageInvoices
      .mockResolvedValueOnce([{ vat_number: null }]) // SELECT vat_number
      .mockResolvedValueOnce([{ id: 'new-inv-1' }]) // INSERT ... RETURNING id
      .mockResolvedValueOnce([]); // UPDATE migration_status

    const run = await importSupplierInvoices('company-1', 'user-1');

    const args = findCall('INSERT INTO supplier_invoices');
    // Column order: company_id, invoice_number, supplier_id, purchase_order_id,
    // project_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount, ...
    const subtotal = args[7];
    const taxRate = args[8];
    const taxAmount = args[9];

    expect(subtotal).toBe('1150.00');
    expect(taxRate).toBe(0);
    expect(taxAmount).toBe('0.00');

    // The old defect: subtotal 1000.00, taxAmount 150.00.
    expect(subtotal).not.toBe('1000.00');
    expect(taxAmount).not.toBe('150.00');
    // The flag is the fix's safeguard: the note lands and the run counts it.
    expect(args).toContain(SAGE_VAT_NOT_STATED_NOTE);
    expect(run.vatNotStated).toBe(1);
  });

  it('takes the tax its lines state when the header states none, and does not flag it', async () => {
    const raw = { Lines: [{ Description: 'A', Tax: 100 }, { Description: 'B', Tax: 50 }] };
    sqlMock
      .mockResolvedValueOnce([{ ...baseRow, subtotal: null, tax_amount: null, raw_data: raw }])
      .mockResolvedValueOnce([{ vat_number: null }])
      .mockResolvedValueOnce([{ id: 'new-inv-1' }])
      .mockResolvedValue([]);

    const run = await importSupplierInvoices('company-1', 'user-1');

    const args = findCall('INSERT INTO supplier_invoices');
    expect(args[7]).toBe('1000.00');
    expect(args[9]).toBe('150.00');
    expect(args).not.toContain(SAGE_VAT_NOT_STATED_NOTE);
    expect(run.vatNotStated).toBe(0);
  });

  it('a row with a stated subtotal keeps it and computes tax by arithmetic', async () => {
    sqlMock
      .mockResolvedValueOnce([{ ...baseRow, subtotal: 1000, tax_amount: null }])
      .mockResolvedValueOnce([{ vat_number: null }])
      .mockResolvedValueOnce([{ id: 'new-inv-1' }])
      .mockResolvedValueOnce([]);

    await importSupplierInvoices('company-1', 'user-1');

    const args = findCall('INSERT INTO supplier_invoices');
    expect(args[7]).toBe('1000.00');
    expect(args[8]).toBe(15);
    expect(args[9]).toBe('150.00');
  });
});

describe('importSupplierInvoices — review round 1 LOW-3: vatNotStated counts only rows that actually import', () => {
  it('a row whose INSERT fails (savepoint rolls back) does not count toward vatNotStated', async () => {
    sqlMock
      .mockResolvedValueOnce([{ ...baseRow, subtotal: null, tax_amount: null }]) // SELECT sageInvoices
      .mockResolvedValueOnce([{ vat_number: null }]) // SELECT vat_number
      .mockRejectedValueOnce(new Error('23505 duplicate')) // INSERT throws
      .mockResolvedValueOnce([]); // UPDATE migration_status = 'failed'

    const { completeRun } = await import('@/modules/accounting/services/core/sageMigrationService');
    const run = await importSupplierInvoices('company-1', 'user-1');

    expect(run.failed).toBe(1);
    expect(run.succeeded).toBe(0);
    expect(run.vatNotStated).toBe(0);
    expect(vi.mocked(completeRun)).toHaveBeenCalledWith(
      'run-1', 1, 0, 1, 0, 0,
    );
  });
});
