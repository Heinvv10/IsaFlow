/**
 * Orchestration-layer tests for supplierStatementReconService.
 *
 * The pure matchLine + buildMissingInvoices helpers have dedicated tests in
 * supplierStatementReconService.test.ts. These tests exercise the composition:
 * fetchRawBytes → VLM → loadSupplierInvoices → buildInserts → persistLines →
 * fetchFullReconciliation. Every external boundary is mocked at the service/DB
 * layer (not at sql), so the tests lock in contract between the orchestrator
 * and its collaborators without reproducing their SQL shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') }),
}));

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/documentStorage', () => ({
  fetchRawBytes: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementWithVlm: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({
  getAPAgingDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/supplierStatementReconDb', () => ({
  loadSupplierInvoices: vi.fn(),
  persistLinesAndUpdateCounts: vi.fn(),
  fetchFullReconciliation: vi.fn(),
}));

import { fetchRawBytes } from '@/lib/documentStorage';
import { getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { extractSupplierStatementWithVlm } from '@/modules/accounting/services/bank/vlmSupplierStatementService';
import {
  loadSupplierInvoices,
  persistLinesAndUpdateCounts,
  fetchFullReconciliation,
} from '@/modules/accounting/services/capture/supplierStatementReconDb';
import { createReconciliation } from '@/modules/accounting/services/capture/supplierStatementReconService';

const COMPANY_ID = 'cccccccc-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'dddddddd-0000-0000-0000-000000000002';
const DOC_ID = 'eeeeeeee-0000-0000-0000-000000000003';
const RECON_ID = 'ffffffff-0000-0000-0000-000000000004';
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000005';

function makeExtraction(overrides: Partial<{
  supplierName: string; statementDate: string;
  periodStart: string; periodEnd: string;
  openingBalance: number; closingBalance: number;
  lines: unknown[]; warnings: string[];
}> = {}) {
  return {
    supplierName: 'Acme Supplies',
    statementDate: '2026-04-20',
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    openingBalance: 0,
    closingBalance: 1000,
    lines: [],
    warnings: [],
    ...overrides,
  };
}

function makeFullReconRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECON_ID,
    companyId: COMPANY_ID,
    supplierId: SUPPLIER_ID,
    supplierName: 'Acme Supplies',
    sourceDocumentId: DOC_ID,
    statementDate: '2026-04-20',
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    supplierBalance: 1000,
    isaflowBalance: 500,
    variance: 500,
    status: 'unreconciled' as const,
    missingInIsaflowCount: 0,
    missingInStatementCount: 0,
    amountDiffCount: 0,
    lines: [],
    missingInvoices: [],
    createdAt: '2026-04-22T08:00:00Z',
    reconciledAt: null,
    ...overrides,
  };
}

/** An AP ageing drill-down whose open invoices carry these balances. */
function agedAt(...balances: number[]) {
  return {
    supplier: { id: SUPPLIER_ID, name: 'Acme Supplies' },
    invoices: balances.map((balance, i) => ({
      id: `inv-${i}`, entityId: SUPPLIER_ID, entityName: 'Acme Supplies', dueDate: '2026-04-30',
      totalAmount: balance, amountPaid: 0, balance,
    })),
    buckets: null,
  };
}

describe('createReconciliation — orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRawBytes).mockResolvedValue({
      buffer: Buffer.from('%PDF-1.4 stub'),
      hash: 'h', size: 13, fileType: 'pdf',
    });
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValue(makeExtraction());
    vi.mocked(loadSupplierInvoices).mockResolvedValue([]);
    vi.mocked(persistLinesAndUpdateCounts).mockResolvedValue(undefined);
    vi.mocked(fetchFullReconciliation).mockResolvedValue(makeFullReconRow());
    vi.mocked(getAPAgingDetail).mockResolvedValue(agedAt(500));
    // recon INSERT RETURNING id
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: RECON_ID }] as never);
  });

  it('throws when fetchRawBytes returns null (document missing from Storage)', async () => {
    vi.mocked(fetchRawBytes).mockResolvedValueOnce(null);

    await expect(
      createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID),
    ).rejects.toThrow(/not found/);
  });

  it('calls the VLM extractor with base64 + application/pdf mime for PDF', async () => {
    await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    expect(vi.mocked(extractSupplierStatementWithVlm)).toHaveBeenCalledTimes(1);
    const [base64, mime] = vi.mocked(extractSupplierStatementWithVlm).mock.calls[0]!;
    expect(typeof base64).toBe('string');
    expect(mime).toBe('application/pdf');
  });

  it('logs but does not throw when extraction returns warnings', async () => {
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({ warnings: ['partial OCR on page 2'] }),
    );

    await expect(
      createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID),
    ).resolves.toBeDefined();
  });

  it('computes variance = supplierBalance - isaflowBalance and threads it into the INSERT', async () => {
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({ closingBalance: 2500 }),
    );
    vi.mocked(getAPAgingDetail).mockResolvedValueOnce(agedAt(600, 400));

    await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    // Our side is the AP ageing for this supplier AS AT the statement date.
    expect(vi.mocked(getAPAgingDetail)).toHaveBeenCalledWith(COMPANY_ID, SUPPLIER_ID, '2026-04-20');
    const insertCall = vi.mocked(sqlMock).mock.calls[0]!;
    // tagged-template interpolation values land after the template strings;
    // assert that 1500 (supplier - isaflow) appears somewhere in the args.
    const flat = JSON.stringify(insertCall);
    expect(flat).toContain('1500');
  });

  it('loads supplier invoices scoped by the extraction period before building inserts', async () => {
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValueOnce(
      makeExtraction({ periodStart: '2026-04-01', periodEnd: '2026-04-30' }),
    );

    await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    expect(vi.mocked(loadSupplierInvoices)).toHaveBeenCalledWith(
      COMPANY_ID, SUPPLIER_ID, '2026-04-01', '2026-04-30',
    );
  });

  it('persists lines via the DB layer — one call with the computed inserts', async () => {
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValueOnce(makeExtraction({
      lines: [
        { date: '2026-04-05', reference: 'INV-001', debit: 1000, description: 'April invoice' },
      ],
    }));
    vi.mocked(loadSupplierInvoices).mockResolvedValueOnce([
      { id: 'inv-a', invoiceNumber: 'INV-001', invoiceDate: '2026-04-05', totalAmount: 1000 },
    ]);

    await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    expect(vi.mocked(persistLinesAndUpdateCounts)).toHaveBeenCalledTimes(1);
    const [persistReconId, persistInserts] = vi.mocked(persistLinesAndUpdateCounts).mock.calls[0]!;
    expect(persistReconId).toBe(RECON_ID);
    // One statement line + (0 missing — the invoice was matched)
    expect(persistInserts.length).toBeGreaterThanOrEqual(1);
  });

  it('persists a missing_in_statement row when an invoice has no statement match', async () => {
    vi.mocked(extractSupplierStatementWithVlm).mockResolvedValueOnce(makeExtraction({ lines: [] }));
    vi.mocked(loadSupplierInvoices).mockResolvedValueOnce([
      { id: 'inv-a', invoiceNumber: 'INV-001', invoiceDate: '2026-04-05', totalAmount: 1000 },
    ]);

    await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    const [, persistInserts] = vi.mocked(persistLinesAndUpdateCounts).mock.calls[0]!;
    const missingRow = persistInserts.find(
      (p: { mismatchReason: string | null }) => p.mismatchReason === 'missing_in_statement',
    );
    expect(missingRow).toBeDefined();
  });

  it('returns the fetchFullReconciliation result on success', async () => {
    const result = await createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID);

    expect(vi.mocked(fetchFullReconciliation)).toHaveBeenCalledWith(COMPANY_ID, RECON_ID);
    expect(result.id).toBe(RECON_ID);
    expect(result.variance).toBe(500);
  });

  it('throws when fetchFullReconciliation returns null (header vanished mid-flight)', async () => {
    vi.mocked(fetchFullReconciliation).mockResolvedValueOnce(null);

    await expect(
      createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID),
    ).rejects.toThrow(/Failed to retrieve/);
  });

  it('throws when the header INSERT returns no row', async () => {
    vi.mocked(sqlMock).mockReset();
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await expect(
      createReconciliation(COMPANY_ID, SUPPLIER_ID, DOC_ID, USER_ID),
    ).rejects.toThrow(/Failed to insert reconciliation header/);
  });
});
