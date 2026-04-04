// RED phase — written before implementation
/**
 * Unit tests for journalEntryService.ts
 *
 * Tests pure logic (validateJournalEntry, mappers) directly, and DB-dependent
 * functions (createJournalEntry, getJournalEntries, postJournalEntry) via
 * mocked sql calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withTransaction: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  getJournalEntries,
  createJournalEntry,
  postJournalEntry,
  getJournalEntryById,
} from '@/modules/accounting/services/journalEntryService';
import {
  validateJournalEntry,
  validateJournalLine,
  formatJournalEntryNumber,
  roundToCents,
} from '@/modules/accounting/utils/doubleEntry';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ENTRY_ID = 'cccccccc-0000-0000-0000-000000000003';
const ACCOUNT_A = 'dddddddd-0000-0000-0000-000000000004';
const ACCOUNT_B = 'eeeeeeee-0000-0000-0000-000000000005';
const FISCAL_ID = 'ffffffff-0000-0000-0000-000000000006';

// ── Shared sample row builders ────────────────────────────────────────────────

function makeEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    entry_number: 'JE-2026-00001',
    entry_date: '2026-03-01',
    fiscal_period_id: FISCAL_ID,
    description: 'Test entry',
    source: 'manual',
    source_document_id: null,
    status: 'draft',
    posted_by: null,
    posted_at: null,
    reversed_by: null,
    reversed_at: null,
    reversal_of_id: null,
    created_by: USER_ID,
    created_at: '2026-03-01T08:00:00Z',
    updated_at: '2026-03-01T08:00:00Z',
    fiscal_period_name: 'March 2026',
    ...overrides,
  };
}

function makeLineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-uuid-001',
    journal_entry_id: ENTRY_ID,
    gl_account_id: ACCOUNT_A,
    debit: 1000,
    credit: 0,
    description: 'Debit line',
    project_id: null,
    cost_center_id: null,
    bu_id: null,
    vat_type: null,
    account_code: '1000',
    account_name: 'Bank Account',
    created_at: '2026-03-01T08:00:00Z',
    updated_at: '2026-03-01T08:00:00Z',
    ...overrides,
  };
}

const balancedLines: JournalLineInput[] = [
  { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
  { glAccountId: ACCOUNT_B, debit: 0, credit: 1000 },
];

const sampleInput: JournalEntryCreateInput = {
  entryDate: '2026-03-01',
  description: 'Test journal entry',
  source: 'manual',
  fiscalPeriodId: FISCAL_ID,
  lines: balancedLines,
};

// ── validateJournalLine (pure function, no mocks needed) ──────────────────────

describe('validateJournalLine', () => {
  it('accepts a valid debit line', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 500, credit: 0 });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid credit line', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_B, debit: 0, credit: 500 });
    expect(result.valid).toBe(true);
  });

  it('rejects a line with no account id', () => {
    const result = validateJournalLine({ glAccountId: '', debit: 500, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('account ID');
  });

  it('rejects a line where both debit and credit are set', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 100, credit: 100 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not both');
  });

  it('rejects a line where both debit and credit are zero', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 0, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-zero');
  });

  it('rejects negative debit', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: -100, credit: 0 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('negative');
  });

  it('rejects negative credit', () => {
    const result = validateJournalLine({ glAccountId: ACCOUNT_A, debit: 0, credit: -50 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('negative');
  });
});

// ── validateJournalEntry (pure function, no mocks needed) ─────────────────────

describe('validateJournalEntry', () => {
  it('accepts a balanced two-line entry', () => {
    const result = validateJournalEntry(balancedLines);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(1000);
    expect(result.totalCredit).toBe(1000);
    expect(result.difference).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an empty lines array', () => {
    const result = validateJournalEntry([]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least'))).toBe(true);
  });

  it('rejects a single-line entry (no double-entry)', () => {
    const result = validateJournalEntry([
      { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('2 lines'))).toBe(true);
  });

  it('rejects unbalanced entries', () => {
    const unbalanced: JournalLineInput[] = [
      { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 500 },
    ];
    const result = validateJournalEntry(unbalanced);
    expect(result.valid).toBe(false);
    expect(result.difference).toBeCloseTo(500, 2);
    expect(result.errors.some(e => e.includes('not balanced'))).toBe(true);
  });

  it('accepts a multi-line entry where totals balance', () => {
    const multiLine: JournalLineInput[] = [
      { glAccountId: ACCOUNT_A, debit: 300, credit: 0 },
      { glAccountId: ACCOUNT_A, debit: 700, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 1000 },
    ];
    const result = validateJournalEntry(multiLine);
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(1000);
    expect(result.totalCredit).toBe(1000);
  });

  it('surfaces individual line errors alongside balance errors', () => {
    const badLines: JournalLineInput[] = [
      { glAccountId: '', debit: 500, credit: 0 },
      { glAccountId: ACCOUNT_B, debit: 0, credit: 500 },
    ];
    const result = validateJournalEntry(badLines);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Line 1'))).toBe(true);
  });
});

// ── formatJournalEntryNumber (pure function) ──────────────────────────────────

describe('formatJournalEntryNumber', () => {
  it('formats correctly with zero-padded sequence', () => {
    expect(formatJournalEntryNumber(2026, 1)).toBe('JE-2026-00001');
    expect(formatJournalEntryNumber(2026, 99999)).toBe('JE-2026-99999');
  });
});

// ── roundToCents (pure function) ──────────────────────────────────────────────

describe('roundToCents', () => {
  it('rounds 0.005 up to 0.01', () => {
    expect(roundToCents(0.005)).toBeCloseTo(0.01, 5);
  });

  it('preserves exact cent values', () => {
    expect(roundToCents(123.45)).toBe(123.45);
  });

  it('handles zero', () => {
    expect(roundToCents(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(roundToCents(-10.999)).toBeCloseTo(-11, 2);
  });
});

// ── getJournalEntries (mocked sql) ────────────────────────────────────────────

describe('getJournalEntries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns paginated entries and total count', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getJournalEntries(COMPANY_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.id).toBe(ENTRY_ID);
    expect(result.total).toBe(1);
  });

  it('maps entry_date to entryDate camelCase', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const { entries } = await getJournalEntries(COMPANY_ID);
    expect(entries[0]!.entryDate).toBe('2026-03-01');
    expect(entries[0]!.status).toBe('draft');
    expect(entries[0]!.source).toBe('manual');
  });

  it('returns empty list when no entries exist', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '0' }] as never);

    const result = await getJournalEntries(COMPANY_ID);
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('applies status filter (uses separate query branch)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ status: 'posted' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getJournalEntries(COMPANY_ID, { status: 'posted' });
    expect(result.entries[0]!.status).toBe('posted');
  });

  it('applies fiscalPeriodId filter', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getJournalEntries(COMPANY_ID, { fiscalPeriodId: FISCAL_ID });
    expect(result.entries[0]!.fiscalPeriodId).toBe(FISCAL_ID);
  });

  it('applies both status and fiscalPeriodId filters together', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ status: 'posted' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getJournalEntries(COMPANY_ID, {
      status: 'posted',
      fiscalPeriodId: FISCAL_ID,
    });
    expect(result.entries[0]!.status).toBe('posted');
    expect(result.entries[0]!.fiscalPeriodId).toBe(FISCAL_ID);
  });

  it('propagates sql errors', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('DB connection failed') as never);
    await expect(getJournalEntries(COMPANY_ID)).rejects.toThrow('DB connection failed');
  });
});

// ── createJournalEntry (mocked sql) ──────────────────────────────────────────

describe('createJournalEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts entry header then lines and returns mapped entry', async () => {
    // resolveUserUuid — UUID-format user, passes straight through
    // fiscal period lookup — skipped (fiscalPeriodId provided in input)
    // INSERT header
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    // INSERT line 1
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // INSERT line 2
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, USER_ID);

    expect(result.id).toBe(ENTRY_ID);
    expect(result.entryNumber).toBe('JE-2026-00001');
    expect(result.status).toBe('draft');
    // sql called at least 3 times: header + 2 lines
    expect(vi.mocked(sql).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws when lines do not balance', async () => {
    const unbalancedInput: JournalEntryCreateInput = {
      ...sampleInput,
      lines: [
        { glAccountId: ACCOUNT_A, debit: 1000, credit: 0 },
        { glAccountId: ACCOUNT_B, debit: 0, credit: 500 },
      ],
    };

    await expect(
      createJournalEntry(COMPANY_ID, unbalancedInput, USER_ID)
    ).rejects.toThrow('Invalid journal entry');
  });

  it('throws when lines array is empty', async () => {
    const emptyInput: JournalEntryCreateInput = { ...sampleInput, lines: [] };

    await expect(
      createJournalEntry(COMPANY_ID, emptyInput, USER_ID)
    ).rejects.toThrow('Invalid journal entry');
  });

  it('resolves non-UUID user IDs by querying users table', async () => {
    // resolveUserUuid — non-UUID, triggers lookup query
    vi.mocked(sql).mockResolvedValueOnce([{ id: USER_ID }] as never);
    // INSERT header
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    // INSERT line 1
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // INSERT line 2
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, 'admin-001');
    expect(result.id).toBe(ENTRY_ID);
  });

  it('falls back to zero UUID when no user row found', async () => {
    // resolveUserUuid — non-UUID, lookup returns empty
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // INSERT header
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    // INSERT lines
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, 'legacy-id');
    expect(result.id).toBe(ENTRY_ID);
  });

  it('looks up fiscal period when none is provided in input', async () => {
    const inputNoPeriod: JournalEntryCreateInput = {
      ...sampleInput,
      fiscalPeriodId: undefined,
    };

    // fiscal period lookup
    vi.mocked(sql).mockResolvedValueOnce([{ id: FISCAL_ID }] as never);
    // INSERT header
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow()] as never);
    // INSERT lines
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    const result = await createJournalEntry(COMPANY_ID, inputNoPeriod, USER_ID);
    expect(result.fiscalPeriodId).toBe(FISCAL_ID);
  });
});

// ── postJournalEntry (mocked sql) ─────────────────────────────────────────────

describe('postJournalEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockGetEntryById(status = 'draft') {
    // getJournalEntryById: entry query
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ status })] as never);
    // getJournalEntryById: lines query
    vi.mocked(sql).mockResolvedValueOnce([
      makeLineRow({ debit: 1000, credit: 0 }),
      makeLineRow({ id: 'line-uuid-002', gl_account_id: ACCOUNT_B, debit: 0, credit: 1000, account_code: '2000', account_name: 'Creditors' }),
    ] as never);
  }

  it('changes status to posted and returns updated entry', async () => {
    mockGetEntryById('draft');
    // fiscal period status check
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'open' }] as never);
    // resolveUserUuid
    // (USER_ID is UUID format — no extra query)
    // UPDATE gl_journal_entries
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ status: 'posted' })] as never);

    const result = await postJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID);
    expect(result.status).toBe('posted');
  });

  it('throws when entry does not exist', async () => {
    // getJournalEntryById returns null (empty rows)
    vi.mocked(sql).mockResolvedValueOnce([] as never);

    await expect(
      postJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)
    ).rejects.toThrow(`Journal entry ${ENTRY_ID} not found`);
  });

  it('throws when entry is already posted', async () => {
    mockGetEntryById('posted');

    await expect(
      postJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)
    ).rejects.toThrow('Cannot post entry with status: posted');
  });

  it('throws when fiscal period is closed', async () => {
    mockGetEntryById('draft');
    // fiscal period status check — closed period
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'closed' }] as never);

    await expect(
      postJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)
    ).rejects.toThrow('Cannot post to closed fiscal period');
  });

  it('throws when entry is reversed', async () => {
    mockGetEntryById('reversed');

    await expect(
      postJournalEntry(COMPANY_ID, ENTRY_ID, USER_ID)
    ).rejects.toThrow('Cannot post entry with status: reversed');
  });
});
