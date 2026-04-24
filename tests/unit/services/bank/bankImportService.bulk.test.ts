/**
 * Tests the bulk-import extensions added to importParsedTransactions:
 *   - writes one bank_import_batches row per call (the function did
 *     not previously persist this row at all)
 *   - propagates bulk_import_id, bulk_sequence, source_filename, and
 *     source_file_size_bytes from the bulkContext option
 *   - inserts the matching bank_transactions rows tagged with the
 *     same batch id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { withTransactionMock, sqlMock } = vi.hoisted(() => {
  const withTransactionMock = vi.fn();
  const sqlMock = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return { withTransactionMock, sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  transaction: vi.fn(),
  withTransaction: withTransactionMock,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/capture/provisionalPostingService', () => ({
  autoProvisionalBatch: vi.fn().mockResolvedValue(undefined),
}));

import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import type { BankCsvParseResult } from '@/modules/accounting/types/bank.types';

function makeParseResult(): BankCsvParseResult {
  return {
    transactions: [
      { transactionDate: '2025-01-15', amount: -100, description: 'Coffee' },
      { transactionDate: '2025-01-16', amount: 5000, description: 'Salary' },
    ],
    bankFormat: 'absa',
    accountNumber: '123456789',
    errors: [],
  };
}

describe('importParsedTransactions — bulk context', () => {
  beforeEach(() => {
    withTransactionMock.mockReset();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  it('writes a bank_import_batches row carrying bulk_import_id and bulk_sequence', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    withTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join('?'), values });
        return Promise.resolve([]);
      };
      return fn(tx);
    });

    const result = await importParsedTransactions(
      'company-1',
      makeParseResult(),
      'gl-bank-acct-1',
      '2025-01-31',
      {
        sourceFilename: 'jan.pdf',
        bulkContext: {
          bulkImportId: 'bulk-uuid-1',
          bulkSequence: 1,
          sourceFilename: 'jan.pdf',
          sourceFileSizeBytes: 12345,
        },
      },
    );

    // Sanity: batchId is a valid uuid-shaped string and we returned the
    // count of inserted transactions.
    expect(result.transactionCount).toBe(2);
    expect(result.batchId).toMatch(/^[0-9a-f-]{36}$/i);

    // First DB call is the batch row insert; the rest are transaction rows.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const batchInsert = calls[0]!;
    expect(batchInsert.text).toContain('bank_import_batches');
    expect(batchInsert.values).toContain('company-1');
    expect(batchInsert.values).toContain('gl-bank-acct-1');
    expect(batchInsert.values).toContain('jan.pdf');
    expect(batchInsert.values).toContain('bulk-uuid-1');
    expect(batchInsert.values).toContain(1);
    expect(batchInsert.values).toContain(12345);
    expect(batchInsert.values).toContain('absa');

    // The two transaction inserts target bank_transactions and reuse the
    // generated batchId so they're linked back to the batch row.
    const txInserts = calls.slice(1, 3);
    for (const c of txInserts) {
      expect(c.text).toContain('bank_transactions');
      expect(c.values).toContain('company-1');
      expect(c.values).toContain('gl-bank-acct-1');
      expect(c.values).toContain(result.batchId);
    }
  });

  it('writes nulls for bulk fields when no bulkContext provided', async () => {
    let batchInsertValues: unknown[] | null = null;
    withTransactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let isFirstCall = true;
      const tx = (_strings: TemplateStringsArray, ...values: unknown[]) => {
        if (isFirstCall) {
          batchInsertValues = values;
          isFirstCall = false;
        }
        return Promise.resolve([]);
      };
      return fn(tx);
    });

    await importParsedTransactions(
      'company-2',
      makeParseResult(),
      'gl-bank-acct-2',
      '2025-02-28',
    );

    expect(batchInsertValues).not.toBeNull();
    // bulk_import_id, bulk_sequence and source_file_size_bytes should
    // all be null in this insert.
    const nullCount = (batchInsertValues!).filter(v => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(3);
  });

  it('returns early without writing any batch row when there are no transactions', async () => {
    const result = await importParsedTransactions(
      'company-3',
      { transactions: [], bankFormat: 'fnb', errors: [] },
      'gl-bank-acct-3',
      '2025-03-31',
    );

    expect(result).toEqual({ batchId: '', transactionCount: 0, errors: [] });
    expect(withTransactionMock).not.toHaveBeenCalled();
  });
});
