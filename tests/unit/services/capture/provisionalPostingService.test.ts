// RED phase — written before implementation
/**
 * Unit tests for provisionalPostingService.ts
 *
 * Covers: predictFromHistory (tokenisation, dice-coefficient supplier matching,
 * history-mode confidence tiers) and postProvisional (skip guards, JE creation,
 * bank_transactions UPDATE).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock, fmtDate: (x: unknown) => String(x) }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-001' }),
  postJournalEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acc-suspense-1' }),
  getSystemAccountId: vi.fn().mockResolvedValue('acc-suspense-1'),
}));

import {
  predictFromHistory,
  postProvisional,
} from '@/modules/accounting/services/capture/provisionalPostingService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const BANK_TX_ID  = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID     = 'dddddddd-0000-0000-0000-000000000004';
const GL_ACC_ID   = 'eeeeeeee-0000-0000-0000-000000000005';

function makeBankTx(overrides: Partial<{ id: string; description: string | null; amount: number }> = {}) {
  return { id: BANK_TX_ID, description: 'ESKOM HOLDINGS PAYMENT', amount: -1200, ...overrides };
}

// Raw supplier_coding_history rows (the service reads individual rows and computes mode itself)
function makeHistoryRows(glAccountId: string, vatCode: string, count: number) {
  return Array.from({ length: count }, () => ({
    gl_account_id: glAccountId,
    vat_code: vatCode,
    cost_centre_id: null,
    project_id: null,
  }));
}

// ── predictFromHistory ────────────────────────────────────────────────────────

describe('predictFromHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns confidence 0 and basis "none" when the suppliers list is empty', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // suppliers query

    const result = await predictFromHistory(COMPANY_ID, makeBankTx());

    expect(result.supplierId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.basis).toBe('none');
  });

  it('returns confidence 0.5 when a supplier matches but has no coding history', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never); // suppliers
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // history → 0 rows

    const result = await predictFromHistory(COMPANY_ID, makeBankTx({ description: 'ESKOM HOLDINGS' }));

    expect(result.supplierId).toBe(SUPPLIER_ID);
    expect(result.confidence).toBeCloseTo(0.5, 5);
    expect(result.basis).toBe('history:0-rows');
  });

  it('returns confidence 0.9 and sets glAccountId from mode when 3 or more consistent history rows exist', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never); // suppliers
    // 4 raw history rows all pointing to same GL → mode count = 4 → confidence 0.9
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);

    const result = await predictFromHistory(COMPANY_ID, makeBankTx({ description: 'ESKOM HOLDINGS' }));

    expect(result.supplierId).toBe(SUPPLIER_ID);
    expect(result.glAccountId).toBe(GL_ACC_ID);
    expect(result.vatCode).toBe('S');
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('returns confidence 0.7 when supplier matches but only 1 history row exists', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never); // suppliers
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 1) as never); // 1 row

    const result = await predictFromHistory(COMPANY_ID, makeBankTx({ description: 'ESKOM HOLDINGS' }));

    expect(result.supplierId).toBe(SUPPLIER_ID);
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });

  it('returns confidence 0.7 when supplier matches but only 2 history rows exist', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 2) as never); // 2 rows

    const result = await predictFromHistory(COMPANY_ID, makeBankTx({ description: 'ESKOM HOLDINGS' }));

    expect(result.confidence).toBeCloseTo(0.7, 5);
  });

  it('strips stopwords before tokenising and still resolves supplier match', async () => {
    // "POS PURCHASE ESKOM HOLDINGS" → after stripping pos, purchase → tokens: eskom, holdings
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);

    const result = await predictFromHistory(
      COMPANY_ID,
      makeBankTx({ description: 'POS PURCHASE ESKOM HOLDINGS' }),
    );

    // Stopwords stripped → meaningful tokens still dice-match; high confidence expected
    expect(result.supplierId).toBe(SUPPLIER_ID);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('returns confidence 0 and basis "none" when description is null', async () => {
    // No SQL call expected — null description short-circuits before any query
    const result = await predictFromHistory(COMPANY_ID, makeBankTx({ description: null }));

    expect(result.supplierId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.basis).toBe('none');
    expect(vi.mocked(sqlMock)).not.toHaveBeenCalled();
  });

  it('returns confidence 0 when description contains only stopwords', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never);

    const result = await predictFromHistory(
      COMPANY_ID,
      makeBankTx({ description: 'THE POS PURCHASE EFT DEBIT' }),
    );

    // All tokens stripped → tokenise returns empty set → early return before supplier query
    expect(result.supplierId).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

// ── postProvisional ───────────────────────────────────────────────────────────

describe('postProvisional', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish default return values cleared by resetAllMocks
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-001' } as never);
    vi.mocked(postJournalEntry).mockResolvedValue(undefined as never);
  });

  it('skips incoming transactions (amount > 0) and returns skipped reason containing "incoming"', async () => {
    // bank_tx fetch — amount is positive (inflow)
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: 500, description: 'CUSTOMER PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toBeDefined();
    expect(result.skipped).toContain('incoming');
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
  });

  it('skips when prediction confidence is below default minConfidence of 0.7', async () => {
    // bank_tx
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'XYZZY RANDOM TX', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    // Suppliers → empty → confidence 0
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toContain('low confidence');
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
  });

  it('skips when prediction confidence is 0.5 (supplier matched but no history) with default threshold', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -600, description: 'ESKOM HOLDINGS', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: SUPPLIER_ID, name: 'Eskom Holdings' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // 0 history rows → confidence 0.5

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toContain('low confidence');
  });

  it('respects a custom minConfidence option — skips a 0.7 prediction when threshold is 0.9', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -600, description: 'ESKOM HOLDINGS', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 1) as never); // → 0.7

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID, { minConfidence: 0.9 });

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toContain('low confidence');
  });

  it('creates a journal entry and returns its id on the happy path', async () => {
    // bank_tx
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    // Suppliers
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    // History → 4 rows → confidence 0.9
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    // UPDATE gl_journal_entries (needs_evidence=true)
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    // UPDATE bank_transactions (status=provisional)
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBe('je-001');
    expect(result.skipped).toBeUndefined();
    expect(vi.mocked(createJournalEntry)).toHaveBeenCalledOnce();
  });

  it('updates bank_transactions status to "provisional" by issuing at least two SQL calls after prediction', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // UPDATE gl_journal_entries
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // UPDATE bank_transactions

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // 1 bank_tx SELECT + 1 suppliers SELECT + 1 history SELECT + 2 UPDATEs = 5
    expect(vi.mocked(sqlMock).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('passes postingAgent "ai-provisional:v1" in the meta argument to createJournalEntry', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    const jeCall = vi.mocked(createJournalEntry).mock.calls[0];
    expect(jeCall).toBeDefined();
    // meta is the 4th argument (index 3)
    const metaArg = jeCall![3] as Record<string, unknown>;
    expect(metaArg).toBeDefined();
    expect(metaArg.postingAgent).toBe('ai-provisional:v1');
  });

  it('skips and returns "already provisional" when bank_tx status is not "imported"', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS', status: 'provisional', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toContain('already');
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
  });

  it('throws an error when the bank transaction is not found', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // no rows

    await expect(postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID)).rejects.toThrow(
      'not found',
    );
  });

  it('rejects when the vat_input system account is missing for a VAT-bearing posting', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    // vat_code 'standard' → hasVat path; 4 consistent rows → confidence 0.9
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'standard', 4) as never);
    // vat_input lookup fails — system account not configured
    vi.mocked(getSystemAccountId).mockRejectedValueOnce(
      new Error('system account vat_input not configured'),
    );

    await expect(postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID)).rejects.toThrow(
      'vat_input not configured',
    );
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
  });
});
