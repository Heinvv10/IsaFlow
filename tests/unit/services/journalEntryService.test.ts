// RED phase — written before implementation
/**
 * Unit tests for journalEntryService.ts
 *
 * Tests pure logic (validateJournalEntry, mappers) directly, and DB-dependent
 * functions (createJournalEntry, getJournalEntries) via
 * mocked sql calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    transaction: vi.fn(),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  getJournalEntries,
  createJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
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

  it('maps a status=reversed filter to a reversed_at IS NOT NULL predicate', async () => {
    // Post reversal-semantics fix, reversed entries keep status='posted' with
    // reversed_at set, so the "Reversed" filter must query reversed_at, not
    // status. This test FAILS if reverted to `AND je.status = ${filters.status}`.
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ reversed_at: '2026-03-02T09:00:00Z' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    await getJournalEntries(COMPANY_ID, { status: 'reversed' });

    const rowsText = (vi.mocked(sql).mock.calls[0]![0] as readonly string[]).join(' ');
    const countText = (vi.mocked(sql).mock.calls[1]![0] as readonly string[]).join(' ');
    expect(rowsText).toMatch(/reversed_at IS NOT NULL/i);
    expect(countText).toMatch(/reversed_at IS NOT NULL/i);
    // the 'reversed' filter value is still bound as a parameter
    expect(vi.mocked(sql).mock.calls[0]!.slice(1)).toContain('reversed');
  });

  it('keeps an exact status match for non-reversed filters (e.g. posted)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([makeEntryRow({ status: 'posted' })] as never);
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: '1' }] as never);

    const result = await getJournalEntries(COMPANY_ID, { status: 'posted' });
    expect(result.entries[0]!.status).toBe('posted');
    expect(vi.mocked(sql).mock.calls[0]!.slice(1)).toContain('posted');
  });
});

// ── createJournalEntry (mocked sql) ──────────────────────────────────────────

describe('createJournalEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts entry header then lines and returns mapped entry', async () => {
    // P2.2: supplied fiscalPeriodId is coverage-validated before anything else
    vi.mocked(sql).mockResolvedValueOnce([{ ok: 1 }] as never);
    // resolveUserUuid — UUID-format user, passes straight through
    // fiscal period lookup — skipped (fiscalPeriodId provided in input)
    // sql.transaction() batches the header INSERT + 2 line INSERTs.
    // Result is an array: [headerRows, line1Rows, line2Rows].
    vi.mocked(sql.transaction).mockResolvedValueOnce([
      [makeEntryRow()],
      [],
      [],
    ] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, USER_ID);

    expect(result.id).toBe(ENTRY_ID);
    expect(result.entryNumber).toBe('JE-2026-00001');
    expect(result.status).toBe('draft');
    expect(vi.mocked(sql.transaction).mock.calls.length).toBe(1);
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
    // P2.2: supplied fiscalPeriodId is coverage-validated before anything else
    vi.mocked(sql).mockResolvedValueOnce([{ ok: 1 }] as never);
    // resolveUserUuid — non-UUID, triggers lookup query (direct sql call)
    vi.mocked(sql).mockResolvedValueOnce([{ id: USER_ID }] as never);
    // sql.transaction — header + 2 lines
    vi.mocked(sql.transaction).mockResolvedValueOnce([
      [makeEntryRow()],
      [],
      [],
    ] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, 'admin-001');
    expect(result.id).toBe(ENTRY_ID);
  });

  it('falls back to zero UUID when no user row found', async () => {
    // P2.2: supplied fiscalPeriodId is coverage-validated before anything else
    vi.mocked(sql).mockResolvedValueOnce([{ ok: 1 }] as never);
    // resolveUserUuid — non-UUID, lookup returns empty (direct sql call)
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    // sql.transaction — header + 2 lines
    vi.mocked(sql.transaction).mockResolvedValueOnce([
      [makeEntryRow()],
      [],
      [],
    ] as never);

    const result = await createJournalEntry(COMPANY_ID, sampleInput, 'legacy-id');
    expect(result.id).toBe(ENTRY_ID);
  });

  it('looks up fiscal period when none is provided in input', async () => {
    const inputNoPeriod: JournalEntryCreateInput = {
      ...sampleInput,
      fiscalPeriodId: undefined,
    };

    // fiscal period lookup (direct sql call)
    vi.mocked(sql).mockResolvedValueOnce([{ id: FISCAL_ID }] as never);
    // sql.transaction — header + 2 lines
    vi.mocked(sql.transaction).mockResolvedValueOnce([
      [makeEntryRow()],
      [],
      [],
    ] as never);

    const result = await createJournalEntry(COMPANY_ID, inputNoPeriod, USER_ID);
    expect(result.fiscalPeriodId).toBe(FISCAL_ID);
  });
});


// Actual posting assertions moved to gl39Posting.int.test.ts; see gl39-assertion-map.md.
