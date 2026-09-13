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

// postProvisional no longer writes a journal of its own: it asks the controlled
// bank allocation to post one, and the allocation owns the journal, the net/VAT
// split, the bank leg and the bank_transactions row.
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateProvisionalTransaction: vi.fn().mockResolvedValue({ journalEntryId: 'je-001', bankTransaction: { id: 'bt-1' } }),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acc-suspense-1' }),
  getSystemAccountId: vi.fn().mockResolvedValue('acc-suspense-1'),
}));

import {
  predictFromHistory,
  postProvisional,
} from '@/modules/accounting/services/capture/provisionalPostingService';
import { allocateProvisionalTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
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
    vi.mocked(allocateProvisionalTransaction).mockResolvedValue({ journalEntryId: 'je-001', bankTransaction: { id: 'bt-1' } } as never);
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
    expect(vi.mocked(allocateProvisionalTransaction)).not.toHaveBeenCalled();
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
    expect(vi.mocked(allocateProvisionalTransaction)).not.toHaveBeenCalled();
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
    expect(vi.mocked(allocateProvisionalTransaction)).toHaveBeenCalledOnce();
    // The prediction reaches the plan — it is what the receipt's fingerprint covers.
    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[0]).toBe(COMPANY_ID);
    expect(call[1]).toBe(BANK_TX_ID);
    expect(call[2]).toBe(GL_ACC_ID);
    expect(call[3]).toBe(USER_ID);
    expect(call[4]).toEqual({ predictedSupplierId: SUPPLIER_ID, confidence: 0.9 });
  });

  it('writes nothing itself — the controlled allocation owns the journal and the bank row', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // UPDATE gl_journal_entries
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // UPDATE bank_transactions

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // Every statement this service issues is a READ. A second writer here would put the row's status, its provisional
    // link and the journal's needs_evidence outside the allocation's receipt, and the next read of that receipt would
    // refuse as 'Allocation receipt source changed'.
    const statements = vi.mocked(sqlMock).mock.calls.map((call) => (call[0] as string[]).join('?'));
    expect(statements.some((text) => /UPDATE|INSERT|DELETE/i.test(text))).toBe(false);
  });

  it('asks for the plain vat code the guards allowed, leaving the split to the allocation', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // 'ai-provisional:v1' is stamped by the allocation effect from the plan's provisional block, not passed as posting
    // metadata from here — proven on the real route in tests/integration/controls/provisionalControl.int.test.ts.
    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[5]).toBe('ESKOM HOLDINGS PAYMENT');
    expect(call[6]).toBe('none');
  });

  it('normalises a legacy vat_code spelling to the plan\'s vocabulary, posting no VAT exactly as before', async () => {
    // supplier_coding_history holds legacy spellings ('S', 'Z') beside the current vocabulary. The plan's enum accepts
    // only the current one, so an unnormalised 'S' would be a ZodError — a FAULT that aborts the whole sweep — where the
    // old arithmetic simply took the no-VAT branch (it split only on 'standard'). Same predicate, same posted amounts.
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -1150, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'S', 4) as never);
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[6]).toBe('none');
    // The allocation posts the gross to the expense account and the gross to the bank leg from this, exactly as the old
    // hasVat=false branch did — the normalisation changes no amount, only the vocabulary.
    expect(['none', 'standard', 'zero_rated', 'exempt']).toContain(call[6]);
  });

  it('skips and returns "already provisional" when bank_tx status is not "imported"', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS', status: 'provisional', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);

    const result = await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    expect(result.journalEntryId).toBeNull();
    expect(result.skipped).toContain('already');
    expect(vi.mocked(allocateProvisionalTransaction)).not.toHaveBeenCalled();
  });

  it('refuses to repeat a wrong claim its own history taught it', async () => {
    // The prediction is the most frequent vat_code on that supplier's prior
    // lines, so a ledger already carrying the defect trains this path to
    // reproduce it — Velocity's salary account has 34 historical lines at
    // 'standard'. Nobody is watching here, so the claim is dropped.
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -1150, description: 'PAYROLL SERVICES EFT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-25' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Payroll Services' }] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'standard', 4) as never);
    vi.mocked(sqlMock).mockResolvedValueOnce(
      [{ vat_input_denied: false, account_code: '49784360', account_name: 'Salaries & Wages - EX4000' }] as never,
    );
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_name: 'Salaries & Wages - EX4000' }] as never);
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // The code the allocation is asked for is 'none', so it posts the gross to the expense account and raises no VAT
    // leg: the guard decides the claim, the allocation does the arithmetic. A 'standard' here is the R237,021.60 shape.
    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[6]).toBe('none');
    // vat_input is never resolved by this service at all — the allocation owns the VAT account.
    expect(vi.mocked(getSystemAccountId).mock.calls.map((c) => c[0]))
      .not.toContain('vat_input');
  });

  it('throws an error when the bank transaction is not found', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never); // no rows

    await expect(postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID)).rejects.toThrow(
      'not found',
    );
  });

  it('passes a surviving standard claim through, leaving the VAT account to the allocation', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([
      { id: BANK_TX_ID, amount: -800, description: 'ESKOM HOLDINGS PAYMENT', status: 'imported', bank_account_id: 'ba-1', transaction_date: '2026-04-10' },
    ] as never);
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: SUPPLIER_ID, name: 'Eskom Holdings' }] as never);
    // vat_code 'standard' → hasVat path; 4 consistent rows → confidence 0.9
    vi.mocked(sqlMock).mockResolvedValueOnce(makeHistoryRows(GL_ACC_ID, 'standard', 4) as never);
    // The unattended VAT guard reads the predicted account before the lines
    // are built — twice, once per statute. A real supply name, so it passes
    // the claim through unchanged and the vat_input lookup below still runs.
    vi.mocked(sqlMock).mockResolvedValueOnce(
      [{ vat_input_denied: false, account_code: '5700', account_name: 'Electricity & Water' }] as never,
    );
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_name: 'Electricity & Water' }] as never);
    // THIRD guard read, and only on a code that survived the other two: the
    // contra's subtype, because a rule whose contra IS a bank account is a
    // transfer and claims nothing. An expense account, so the claim stands.
    vi.mocked(sqlMock).mockResolvedValueOnce([{ account_subtype: 'default_expense' }] as never);
    vi.mocked(sqlMock).mockResolvedValue([] as never);

    await postProvisional(COMPANY_ID, BANK_TX_ID, USER_ID);

    // A claim none of the three guards objected to reaches the allocation as 'standard'; the allocation resolves the
    // VAT system account and REFUSES when it is missing or ambiguous ('Allocation VAT account unavailable'), so this
    // service no longer resolves vat_input or does the net/VAT arithmetic.
    const call = vi.mocked(allocateProvisionalTransaction).mock.calls[0]!;
    expect(call[6]).toBe('standard');
    expect(vi.mocked(getSystemAccountId).mock.calls.map((c) => c[0])).not.toContain('vat_input');
  });
});
