// RED phase — written before implementation.
/**
 * bankStatementImportService — the agent-facing statement import path.
 *
 * Exists because dedup lives in the endpoint layer today (bulk-commit,
 * bulk-preview, extension-ingest each carry their own copy) while
 * importParsedTransactions does not dedup at all. An MCP tool built on the
 * service alone would duplicate the bank on any retry, so the dedup moves
 * into a service both callers can share.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d ?? '') };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankStatementParseService', () => ({
  parseStatement: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankImportService', () => ({
  importParsedTransactions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionQueryService', () => ({
  deleteTransactions: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';
import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { deleteTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import {
  bankGlAccountBelongsToCompany,
  importStatementForAgent,
  undoImportBatch,
} from '@/modules/accounting/services/bank/bankStatementImportService';

const COMPANY = 'company-1';
const ACCOUNT = 'acct-1';

/** Two distinct transactions, both inside one statement. */
const TX_A = { transactionDate: '2026-04-15', amount: -1234.56, description: 'PAYMENT TO ACME' };
const TX_B = { transactionDate: '2026-04-16', amount: 5000, description: 'CLIENT DEPOSIT' };

function parsed(transactions: Array<Record<string, unknown>>) {
  return { transactions, errors: [], bankFormat: 'ofx' };
}

const baseArgs = {
  companyId: COMPANY,
  bankAccountId: ACCOUNT,
  fileType: 'ofx' as const,
  content: '<OFX>…</OFX>',
  statementDate: '2026-04-30',
  importedBy: 'mcp:import_bank_statement:v1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sql).mockResolvedValue([] as never);
  vi.mocked(importParsedTransactions).mockResolvedValue({
    batchId: 'batch-1',
    transactionCount: 2,
    errors: [],
  } as never);
});

describe('importStatementForAgent', () => {
  it('a dry run reports what would land but writes nothing', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([TX_A, TX_B]) as never);

    const res = await importStatementForAgent({ ...baseArgs, dryRun: true });

    expect(res.imported).toBe(2);
    expect(res.duplicates).toBe(0);
    expect(res.batchId).toBeNull();
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });

  it('skips transactions already in the account and imports only the new ones', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([TX_A, TX_B]) as never);
    // TX_A already exists in the DB for this account/date window.
    vi.mocked(sql).mockResolvedValueOnce([
      { transaction_date: TX_A.transactionDate, amount: TX_A.amount, description: TX_A.description },
    ] as never);

    const res = await importStatementForAgent(baseArgs);

    expect(res.duplicates).toBe(1);
    expect(res.imported).toBe(1);
    const passed = vi.mocked(importParsedTransactions).mock.calls[0]![1] as {
      transactions: Array<{ description: string }>;
    };
    expect(passed.transactions).toHaveLength(1);
    expect(passed.transactions[0]!.description).toBe('CLIENT DEPOSIT');
  });

  it('re-importing the identical statement writes nothing the second time', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([TX_A, TX_B]) as never);
    vi.mocked(sql).mockResolvedValueOnce([
      { transaction_date: TX_A.transactionDate, amount: TX_A.amount, description: TX_A.description },
      { transaction_date: TX_B.transactionDate, amount: TX_B.amount, description: TX_B.description },
    ] as never);

    const res = await importStatementForAgent(baseArgs);

    expect(res.imported).toBe(0);
    expect(res.duplicates).toBe(2);
    expect(res.batchId).toBeNull();
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });

  it('suppresses the auto-post sweep so no journal is posted by an import', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([TX_A]) as never);

    await importStatementForAgent(baseArgs);

    const opts = vi.mocked(importParsedTransactions).mock.calls[0]![4] as {
      skipPostImportEffects?: boolean;
      importedBy?: string;
    };
    expect(opts.skipPostImportEffects).toBe(true);
    expect(opts.importedBy).toBe('mcp:import_bank_statement:v1');
  });

  it('matches a stored negative half-cent amount instead of re-importing it forever', async () => {
    // amount is NUMERIC(15,2): Postgres stores -25.005 as -25.01 (half away
    // from zero) while Math.round would hash it as -25.00 (half toward +Inf).
    // Mismatched hashes mean the row never dedups and lands again every retry.
    const HALF_CENT = { transactionDate: '2026-04-15', amount: -25.005, description: 'ROUNDING' };
    vi.mocked(parseStatement).mockResolvedValue(parsed([HALF_CENT]) as never);
    vi.mocked(sql).mockResolvedValueOnce([
      { transaction_date: '2026-04-15', amount: -25.01, description: 'ROUNDING' },
    ] as never);

    const res = await importStatementForAgent(baseArgs);

    expect(res.duplicates).toBe(1);
    expect(res.imported).toBe(0);
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });

  it('refuses an impossible calendar date instead of letting Postgres abort the transaction', async () => {
    // The OFX/MT940 parsers only reject day > 31, so <DTPOSTED>20260231 yields
    // a well-formed '2026-02-31'. Interpolated into ::DATE that raises 22008,
    // aborts the request transaction, and surfaces as a generic failure.
    vi.mocked(parseStatement).mockResolvedValue(
      parsed([{ transactionDate: '2026-02-31', amount: -10, description: 'FEB 31' }]) as never,
    );

    await expect(importStatementForAgent(baseArgs)).rejects.toThrow(/recognisable/i);
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });

  it('refuses a statement with no parseable dates rather than importing with dedup off', async () => {
    // A null date range would query nothing, leave the seen-set empty, and
    // import every row while still reporting duplicates: 0.
    vi.mocked(parseStatement).mockResolvedValue(
      parsed([{ transactionDate: '12026/04/15', amount: -10, description: 'BAD DATE' }]) as never,
    );

    await expect(importStatementForAgent(baseArgs)).rejects.toThrow(/recognisable/i);
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });

  it('scopes the duplicate lookup by company, not by bank account alone', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([TX_A]) as never);

    await importStatementForAgent(baseArgs);

    // The tagged-template call records its interpolated values as extra args.
    const values = vi.mocked(sql).mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
  });

  it('imports the rows it could parse and surfaces the failed rows alongside them', async () => {
    // Deliberate: a partial statement IS imported. The unparseable rows are
    // reported so the caller can decide, not withheld — a bank statement with
    // one bad line should not block the other 400.
    vi.mocked(parseStatement).mockResolvedValue({
      transactions: [TX_A],
      errors: [{ row: 4, error: 'unparseable amount' }],
      bankFormat: 'ofx',
    } as never);

    const res = await importStatementForAgent(baseArgs);

    expect(res.parseErrors).toEqual([{ row: 4, error: 'unparseable amount' }]);
    expect(res.imported).toBe(1);
    expect(importParsedTransactions).toHaveBeenCalled();
  });

  it('returns an empty result for a statement with no transactions', async () => {
    vi.mocked(parseStatement).mockResolvedValue(parsed([]) as never);

    const res = await importStatementForAgent(baseArgs);

    expect(res.imported).toBe(0);
    expect(res.batchId).toBeNull();
    expect(importParsedTransactions).not.toHaveBeenCalled();
  });
});

describe('undoImportBatch', () => {
  it('deletes the still-imported rows and reports the refusals broken down by status', async () => {
    // Only 'allocated' is undoable with reverse_bank_allocation; reporting a
    // reconciled or excluded row as "allocated" would send the caller down a
    // recovery path that cannot work.
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: 'batch-1' }] as never)   // batch belongs to company
      .mockResolvedValueOnce([                                 // its transactions
        { id: 'tx-1', status: 'imported' },
        { id: 'tx-2', status: 'imported' },
        { id: 'tx-3', status: 'allocated' },
        { id: 'tx-4', status: 'reconciled' },
        { id: 'tx-5', status: 'excluded' },
      ] as never);
    vi.mocked(deleteTransactions).mockResolvedValue(2);

    const res = await undoImportBatch(COMPANY, 'batch-1');

    expect(res).toEqual({
      deleted: 2,
      refused: 3,
      refusedByStatus: { allocated: 1, reconciled: 1, excluded: 1 },
    });
    expect(deleteTransactions).toHaveBeenCalledWith(COMPANY, ['tx-1', 'tx-2']);
  });

  it('returns null for a batch belonging to another company — never touches its rows', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const res = await undoImportBatch(COMPANY, 'someone-elses-batch');

    expect(res).toBeNull();
    expect(deleteTransactions).not.toHaveBeenCalled();
  });

  it('only reaches agent-created batches — a human UI batch id is not undoable', async () => {
    // list_bank_transactions hands out import_batch_id for every row, so
    // without the imported_by filter an agent could read a human's batch id
    // from a read tool and delete that batch outright.
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const res = await undoImportBatch(COMPANY, 'human-ui-batch');

    expect(res).toBeNull();
    expect(deleteTransactions).not.toHaveBeenCalled();
    const batchQuery = (vi.mocked(sql).mock.calls[0]![0] as unknown as string[]).join('?');
    expect(batchQuery).toContain('imported_by');
    expect(batchQuery).toContain('mcp:%');
  });
});

describe('bankGlAccountBelongsToCompany', () => {
  it('accepts only an active bank-subtype GL account in this company', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ id: ACCOUNT }] as never);

    await expect(bankGlAccountBelongsToCompany(COMPANY, ACCOUNT)).resolves.toBe(true);

    const call = vi.mocked(sql).mock.calls[0]!;
    const text = (call[0] as unknown as string[]).join('?');
    expect(text).toContain('company_id');
    expect(text).toContain('account_subtype');
    expect(call.slice(1)).toContain(COMPANY);
  });

  it('rejects an account that is not in this company', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(bankGlAccountBelongsToCompany(COMPANY, 'foreign-acct')).resolves.toBe(false);
  });
});
