// RED phase — written before implementation
/**
 * Unit tests for bank reconciliation services:
 *   - importBankStatement (bankImportService.ts)
 *   - getBankTransactions (bankTransactionQueryService.ts)
 *   - matchTransaction (bankTransactionQueryService.ts)
 *   - autoMatchTransactions (bankReconciliationService.ts)
 *   - fmtDate / mapTxRow (bankTransactionQueryService.ts — pure helpers)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// sql.unsafe is called inside getBankTransactions for the bankAccountId+status
// filter branch.  Use vi.hoisted so the mock reference is available inside
// the vi.mock factory (which is hoisted to the top of the file by Vitest).
const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  transaction: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql, transaction } from '@/lib/neon';
import { importBankStatement } from '@/modules/accounting/services/bankImportService';
import {
  getBankTransactions,
  matchTransaction,
  fmtDate,
  mapTxRow,
} from '@/modules/accounting/services/bankTransactionQueryService';
import { autoMatchTransactions } from '@/modules/accounting/services/bankReconciliationService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const BANK_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const TX_ID = 'cccccccc-0000-0000-0000-000000000003';
const JL_ID = 'dddddddd-0000-0000-0000-000000000004';
const RECON_ID = 'eeeeeeee-0000-0000-0000-000000000005';

// ── Shared row builders ───────────────────────────────────────────────────────

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    bank_account_id: BANK_ACCOUNT_ID,
    transaction_date: '2026-03-10',
    value_date: null,
    amount: -1500,
    description: 'WOOLWORTHS SANDTON',
    reference: 'REF-001',
    bank_reference: null,
    status: 'imported',
    matched_journal_line_id: null,
    reconciliation_id: null,
    import_batch_id: null,
    exclude_reason: null,
    notes: null,
    suggested_gl_account_id: null,
    suggested_supplier_id: null,
    suggested_client_id: null,
    suggested_category: null,
    suggested_cost_centre: null,
    suggested_vat_code: null,
    suggested_confidence: null,
    cc1_id: null,
    cc2_id: null,
    bu_id: null,
    created_at: '2026-03-10T09:00:00Z',
    updated_at: '2026-03-10T09:00:00Z',
    bank_account_name: 'FNB Business Cheque',
    matched_entry_number: null,
    suggested_gl_account_name: null,
    suggested_gl_account_code: null,
    suggested_supplier_name: null,
    suggested_client_name: null,
    cc1_name: null,
    cc2_name: null,
    bu_name: null,
    allocation_type: null,
    allocated_entity_name: null,
    ...overrides,
  };
}

// ── FNB CSV fixture (format: Date,Description,Amount,Balance,Reference YYYY/MM/DD) ──

const FNB_CSV = `"Date","Description","Amount","Balance","Reference"
"2026/03/10","WOOLWORTHS SANDTON","-1500.00","-2500.00","REF-001"
"2026/03/11","SALARY PAYMENT","50000.00","47500.00","SAL-MAR"
`;

// ────────────────────────────────────────────────────────────────────────────
// fmtDate — pure helper
// ────────────────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('formats a Date object to YYYY-MM-DD', () => {
    expect(fmtDate(new Date('2026-03-10T00:00:00Z'))).toBe('2026-03-10');
  });

  it('trims ISO timestamp strings to date part', () => {
    expect(fmtDate('2026-03-10T09:00:00Z')).toBe('2026-03-10');
  });

  it('returns empty string for falsy values', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
    expect(fmtDate('')).toBe('');
  });

  it('passes through a plain date string unchanged', () => {
    expect(fmtDate('2026-03-10')).toBe('2026-03-10');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mapTxRow — pure row mapper
// ────────────────────────────────────────────────────────────────────────────

describe('mapTxRow', () => {
  it('maps all required fields correctly', () => {
    const row = makeTxRow();
    const tx = mapTxRow(row);

    expect(tx.id).toBe(TX_ID);
    expect(tx.bankAccountId).toBe(BANK_ACCOUNT_ID);
    expect(tx.transactionDate).toBe('2026-03-10');
    expect(tx.amount).toBe(-1500);
    expect(tx.description).toBe('WOOLWORTHS SANDTON');
    expect(tx.reference).toBe('REF-001');
    expect(tx.status).toBe('imported');
    expect(tx.bankAccountName).toBe('FNB Business Cheque');
  });

  it('maps optional fields as undefined when null in DB', () => {
    const tx = mapTxRow(makeTxRow());
    expect(tx.valueDate).toBeUndefined();
    expect(tx.matchedJournalLineId).toBeUndefined();
    expect(tx.reconciliationId).toBeUndefined();
    expect(tx.suggestedGlAccountId).toBeUndefined();
    expect(tx.excludeReason).toBeUndefined();
  });

  it('maps suggested fields when present', () => {
    const row = makeTxRow({
      suggested_gl_account_id: 'acc-uuid',
      suggested_gl_account_name: 'Office Expenses',
      suggested_gl_account_code: '5100',
      suggested_confidence: 0.87,
    });
    const tx = mapTxRow(row);
    expect(tx.suggestedGlAccountId).toBe('acc-uuid');
    expect(tx.suggestedGlAccountName).toBe('Office Expenses');
    expect(tx.suggestedGlAccountCode).toBe('5100');
    expect(tx.suggestedConfidence).toBe(0.87);
  });

  it('strips "none" from suggestedVatCode (returns undefined)', () => {
    const row = makeTxRow({ suggested_vat_code: 'none' });
    const tx = mapTxRow(row);
    expect(tx.suggestedVatCode).toBeUndefined();
  });

  it('preserves a real vat code', () => {
    const row = makeTxRow({ suggested_vat_code: 'standard' });
    const tx = mapTxRow(row);
    expect(tx.suggestedVatCode).toBe('standard');
  });

  it('casts amount to number', () => {
    const row = makeTxRow({ amount: '1234.56' });
    const tx = mapTxRow(row);
    expect(typeof tx.amount).toBe('number');
    expect(tx.amount).toBeCloseTo(1234.56, 2);
  });

  it('maps allocation_type when present', () => {
    const row = makeTxRow({ allocation_type: 'supplier', allocated_entity_name: 'Takealot' });
    const tx = mapTxRow(row);
    expect(tx.allocationType).toBe('supplier');
    expect(tx.allocatedEntityName).toBe('Takealot');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// importBankStatement
// ────────────────────────────────────────────────────────────────────────────

describe('importBankStatement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses FNB CSV and inserts transactions via transaction()', async () => {
    vi.mocked(transaction).mockResolvedValueOnce([] as never);

    const result = await importBankStatement(
      COMPANY_ID,
      FNB_CSV,
      BANK_ACCOUNT_ID,
      '2026-03-31',
      'fnb'
    );

    expect(result.transactionCount).toBe(2);
    expect(result.batchId).toBeTruthy();
    expect(result.errors).toHaveLength(0);
    expect(vi.mocked(transaction)).toHaveBeenCalledOnce();
  });

  it('auto-detects FNB format when bankFormat is omitted', async () => {
    vi.mocked(transaction).mockResolvedValueOnce([] as never);

    const result = await importBankStatement(
      COMPANY_ID,
      FNB_CSV,
      BANK_ACCOUNT_ID,
      '2026-03-31'
      // no bankFormat — detectBankFormat should return 'fnb'
    );

    expect(result.transactionCount).toBe(2);
  });

  it('returns transactionCount 0 and empty batchId when no parseable rows', async () => {
    const headerOnlyCsv = `"Date","Description","Amount","Balance","Reference"\n`;

    const result = await importBankStatement(
      COMPANY_ID,
      headerOnlyCsv,
      BANK_ACCOUNT_ID,
      '2026-03-31',
      'fnb'
    );

    expect(result.transactionCount).toBe(0);
    expect(result.batchId).toBe('');
    expect(vi.mocked(transaction)).not.toHaveBeenCalled();
  });

  it('throws when format cannot be detected from unknown content', async () => {
    await expect(
      importBankStatement(COMPANY_ID, 'garbage,csv,data\n1,2,3', BANK_ACCOUNT_ID, '2026-03-31', 'unknown')
    ).rejects.toThrow('Unable to detect bank format');
  });

  it('propagates transaction() errors', async () => {
    vi.mocked(transaction).mockRejectedValueOnce(new Error('DB write failed') as never);

    await expect(
      importBankStatement(COMPANY_ID, FNB_CSV, BANK_ACCOUNT_ID, '2026-03-31', 'fnb')
    ).rejects.toThrow('DB write failed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getBankTransactions
// ────────────────────────────────────────────────────────────────────────────

describe('getBankTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // sql.unsafe is called in the bankAccountId+status filter branch
    vi.mocked(sql).unsafe = vi.fn().mockReturnValue('');
  });

  it('returns transactions and total for a company (no filters)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeTxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.id).toBe(TX_ID);
    expect(result.total).toBe(1);
  });

  it('returns empty list when no transactions exist', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '0' }] as never);

    const result = await getBankTransactions(COMPANY_ID);
    expect(result.transactions).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('uses reconciliationId filter branch when provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeTxRow({ reconciliation_id: RECON_ID })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID, { reconciliationId: RECON_ID });
    expect(result.transactions[0]!.id).toBe(TX_ID);
  });

  it('uses bankAccountId-only filter branch when only bankAccountId is provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeTxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID, { bankAccountId: BANK_ACCOUNT_ID });
    expect(result.transactions[0]!.bankAccountId).toBe(BANK_ACCOUNT_ID);
  });

  it('uses bankAccountId + status filter branch when both provided (exercises sql.unsafe)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeTxRow({ status: 'matched' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getBankTransactions(COMPANY_ID, {
      bankAccountId: BANK_ACCOUNT_ID,
      status: 'matched',
    });
    expect(result.transactions[0]!.status).toBe('matched');
    // sql.unsafe should have been called to inject sortDir and filter conditions
    expect(vi.mocked(sql).unsafe).toHaveBeenCalled();
  });

  it('maps each row through mapTxRow (camelCase fields)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeTxRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const { transactions } = await getBankTransactions(COMPANY_ID);
    const tx = transactions[0]!;
    expect(tx.bankAccountId).toBeDefined();
    expect(tx.transactionDate).toBe('2026-03-10');
    expect(tx.bankAccountName).toBe('FNB Business Cheque');
  });

  it('propagates sql errors to the caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('query timeout') as never);

    await expect(getBankTransactions(COMPANY_ID)).rejects.toThrow('query timeout');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// matchTransaction
// ────────────────────────────────────────────────────────────────────────────

describe('matchTransaction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets status to matched and links journal line id', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      makeTxRow({ status: 'matched', matched_journal_line_id: JL_ID }),
    ] as never);

    const result = await matchTransaction(COMPANY_ID, TX_ID, JL_ID);
    expect(result.status).toBe('matched');
    expect(result.matchedJournalLineId).toBe(JL_ID);
  });

  it('includes reconciliationId in result when the UPDATE branch sets it', async () => {
    // The service uses a different SQL branch when reconciliationId is supplied.
    // The returned DB row will include the reconciliation_id that was set.
    vi.mocked(sql).mockResolvedValueOnce([
      makeTxRow({
        status: 'matched',
        matched_journal_line_id: JL_ID,
        reconciliation_id: RECON_ID,
      }),
    ] as never);

    const result = await matchTransaction(COMPANY_ID, TX_ID, JL_ID, RECON_ID);
    expect(result.status).toBe('matched');
    expect(result.matchedJournalLineId).toBe(JL_ID);
    expect(result.reconciliationId).toBe(RECON_ID);
  });

  it('returns undefined reconciliationId when column is null in returned row', async () => {
    // Without a reconciliationId arg, the UPDATE does not touch the column;
    // the returned row has reconciliation_id = null → mapped to undefined.
    vi.mocked(sql).mockResolvedValueOnce([
      makeTxRow({
        status: 'matched',
        matched_journal_line_id: JL_ID,
        reconciliation_id: null,
      }),
    ] as never);

    const result = await matchTransaction(COMPANY_ID, TX_ID, JL_ID);
    expect(result.reconciliationId).toBeUndefined();
  });

  it('throws when the UPDATE returns no rows (transaction not found)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(matchTransaction(COMPANY_ID, TX_ID, JL_ID)).rejects.toThrow(
      `Bank transaction ${TX_ID} not found`
    );
  });

  it('propagates sql errors to the caller', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('FK violation') as never);

    await expect(matchTransaction(COMPANY_ID, TX_ID, JL_ID)).rejects.toThrow('FK violation');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// autoMatchTransactions
// ────────────────────────────────────────────────────────────────────────────

describe('autoMatchTransactions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zeros and empty candidates when no unmatched bank transactions exist', async () => {
    // bank_transactions query — empty
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('returns unmatched count when GL has no posted lines', async () => {
    // bank_transactions — one unmatched tx
    vi.mocked(sql).mockResolvedValueOnce([
      { id: TX_ID, amount: -1500, transaction_date: '2026-03-10', reference: null, description: 'TEST' },
    ] as never);
    // gl_journal_lines — empty
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
  });

  it('auto-matches a deposit when bank amount matches GL credit line on same date', async () => {
    // bank tx: +5000 (deposit received — isDeposit = true)
    // Algorithm checks line.credit for deposits
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: TX_ID,
        amount: 5000,
        transaction_date: '2026-03-10',
        reference: 'INV-2026-0042',
        description: 'CUSTOMER PAYMENT INV-2026-0042',
      },
    ] as never);
    // GL line: credit 5000 on same date — reference matches (confidence 1.0)
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: JL_ID,
        debit: 0,
        credit: 5000,
        description: 'Customer payment: INV-2026-0042',
        entry_date: '2026-03-10',
        entry_number: 'JE-2026-00001',
        source_document_id: null,
      },
    ] as never);
    // matchTransaction UPDATE — called because confidence >= 0.9
    vi.mocked(sql).mockResolvedValueOnce([
      makeTxRow({ amount: 5000, status: 'matched', matched_journal_line_id: JL_ID }),
    ] as never);

    const result = await autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  it('auto-matches a withdrawal when bank debit matches GL debit line on same date', async () => {
    // bank tx: -2500 (payment out — isDeposit = false)
    // Algorithm checks line.debit for withdrawals
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: TX_ID,
        amount: -2500,
        transaction_date: '2026-03-12',
        reference: null,
        description: 'LEASE PAYMENT MARCH',
      },
    ] as never);
    // GL line: debit 2500 on same date, amount + date = Tier 2 confidence 0.9
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: JL_ID,
        debit: 2500,
        credit: 0,
        description: 'Rent expense',
        entry_date: '2026-03-12',
        entry_number: 'JE-2026-00002',
        source_document_id: null,
      },
    ] as never);
    // matchTransaction UPDATE
    vi.mocked(sql).mockResolvedValueOnce([
      makeTxRow({ amount: -2500, status: 'matched', matched_journal_line_id: JL_ID }),
    ] as never);

    const result = await autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
  });

  it('leaves low-confidence matches as candidates without calling matchTransaction', async () => {
    // bank tx with vague description
    vi.mocked(sql).mockResolvedValueOnce([
      { id: TX_ID, amount: -1500, transaction_date: '2026-03-10', reference: null, description: 'MISC PAYMENT' },
    ] as never);
    // GL line with same amount but completely different description and date (2 months earlier)
    vi.mocked(sql).mockResolvedValueOnce([
      {
        id: JL_ID,
        debit: 0,
        credit: 1500,
        description: 'UNRELATED EXPENSE',
        entry_date: '2026-01-05',
        entry_number: 'JE-2026-00099',
        source_document_id: null,
      },
    ] as never);
    // matchTransaction should NOT be called; no further sql calls expected

    const result = await autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID);
    expect(result.matched).toBe(0);
    // Transaction appears either as a candidate or unmatched — not auto-committed
    const totalAccountedFor = result.candidates.length + result.unmatched;
    expect(totalAccountedFor).toBeGreaterThan(0);
    // Confirm no matchTransaction UPDATE was issued
    expect(vi.mocked(sql).mock.calls.length).toBe(2); // only bank txs + GL lines queries
  });

  it('propagates sql errors from the bank transaction query', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('connection refused') as never);

    await expect(
      autoMatchTransactions(COMPANY_ID, BANK_ACCOUNT_ID)
    ).rejects.toThrow('connection refused');
  });
});
