/**
 * Bank-row dimension sync — the parts that are not SQL (the SQL is proven against a real
 * database in tests/integration/bank-dimension-sync*.int.test.ts): which slots a mirror
 * blanks, how a preview is shaped and capped, and when a live run refuses or writes nothing.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn(() => ({})) }) }));

import { sql } from '@/lib/neon';
import {
  applyBankSyncBatch, applyBankSync, previewBankSync, writeBankRows, MAX_BANK_SYNC_ROWS,
} from '@/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { blankedSlots, BankDimensionSyncRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionBankSyncTypes';
import { isControlSubtypeSql } from '@/modules/accounting/services/gl/dimensions/journalDimensionSetSql';
import { CONTROL_RAW_SUBTYPES } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const BATCH = '99999999-9999-4999-8999-999999999999';
const F1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'cccccccc-0000-4000-8000-000000000001';
const B1 = 'dddddddd-0000-4000-8000-000000000001';
const WINDOW = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };

const row = (n: number, over: Record<string, unknown> = {}) => ({
  bank_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, tx_date: '2026-10-02', amount: -100, description: `tx ${n}`,
  o1: null, o2: null, ob: null, n1: F1, n2: P1, nb: null, total: 1, ...over,
});

beforeEach(() => mockSql.mockReset());

describe('blankedSlots — a mirror blanks what the journal does not carry', () => {
  const none = { cc1Id: null, cc2Id: null, buId: null };
  it.each([
    ['nothing held, nothing blanked', none, { cc1Id: F1, cc2Id: P1, buId: null }, []],
    ['a CC1-only journal blanks CC2 and BU', { cc1Id: F1, cc2Id: P1, buId: B1 }, { cc1Id: F1, cc2Id: null, buId: null }, ['cc2', 'bu']],
    ['all cleared blanks all three', { cc1Id: F1, cc2Id: P1, buId: B1 }, none, ['cc1', 'cc2', 'bu']],
    ['a value replaced by another is a change, not a blank', { cc1Id: F1, cc2Id: null, buId: null }, { cc1Id: P1, cc2Id: null, buId: null }, []],
  ] as const)('%s', (_l, old, next, want) => {
    expect(blankedSlots(old, next)).toEqual(want);
  });
});

describe('the control-account predicate is built from the one control vocabulary', () => {
  it('names every raw control spelling and nothing is left out', () => {
    const text = isControlSubtypeSql('x.account_subtype');
    for (const raw of CONTROL_RAW_SUBTYPES) expect(text).toContain(`'${raw}'`);
    expect(CONTROL_RAW_SUBTYPES).toEqual(expect.arrayContaining(['bank', 'payable', 'receivable', 'vat_input', 'vat_output', 'vat_input_late_claim', 'payroll_liability']));
    expect(text).toMatch(/^COALESCE\(regexp_replace\(lower\(btrim\(x\.account_subtype\)\)/);
  });
});

describe('previewBankSync', () => {
  it('reports the total, sorts by date, samples, and lists EVERY row that would lose a value', async () => {
    mockSql.mockResolvedValueOnce([
      row(3, { tx_date: '2026-10-09', total: 3, o1: F1, o2: P1, n2: null }),
      row(1, { tx_date: '2026-10-05', total: 3 }),
      row(2, { tx_date: '2026-10-02', total: 3, ob: B1, n1: null, n2: null }),
    ]);
    const p = await previewBankSync(COMPANY, WINDOW, { sample: 2 });
    expect(p).toMatchObject({ count: 3, overMaxRows: false, maxRows: MAX_BANK_SYNC_ROWS });
    expect(p.sample.map((r) => r.description)).toEqual(['tx 2', 'tx 1']);
    expect(p.blanking.map((r) => [r.description, r.blanks])).toEqual([['tx 2', ['bu']], ['tx 3', ['cc2']]]);
  });

  it('over the cap: the total is reported, the list is cut to the cap, and the flag says the live call would refuse', async () => {
    mockSql.mockResolvedValueOnce([row(1, { total: 5 }), row(2, { total: 5 }), row(3, { total: 5 })]);
    const p = await previewBankSync(COMPANY, WINDOW, { maxRows: 2 });
    expect(p).toMatchObject({ count: 5, overMaxRows: true, maxRows: 2 });
    expect(p.sample).toHaveLength(2);
  });

  it('needs a scope: neither a batch nor a window is refused before any query', async () => {
    await expect(previewBankSync(COMPANY, {})).rejects.toBeInstanceOf(BankDimensionSyncRefusal);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('the live path', () => {
  it('refuses a window over the cap, naming the remedy, before any write', async () => {
    mockSql.mockResolvedValueOnce([row(1, { total: 0 }), row(2, { total: 0 }), row(3, { total: 0 })]);
    await expect(applyBankSyncBatch(COMPANY, WINDOW, { idempotencyKey: 'k', userId: 'u', maxRows: 2 }))
      .rejects.toThrow(/more than 2 bank transactions: narrow date_from \/ date_to/);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('writes no batch when nothing would change', async () => {
    mockSql.mockResolvedValueOnce([]);
    expect(await applyBankSyncBatch(COMPANY, WINDOW, { idempotencyKey: 'k', userId: 'u' })).toEqual({ batchId: null, bankRowCount: 0 });
    expect(mockSql).toHaveBeenCalledTimes(1);
    mockSql.mockResolvedValueOnce([]);
    expect(await applyBankSync(COMPANY, BATCH, { tagBatchId: BATCH })).toBe(0);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('records the window on the batch it writes', async () => {
    mockSql
      .mockResolvedValueOnce([row(1, { total: 0 })])
      .mockResolvedValueOnce([{ id: BATCH }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: row(1).bank_id }]);
    const out = await applyBankSyncBatch(COMPANY, WINDOW, { idempotencyKey: 'k', userId: 'u' });
    expect(out).toEqual({ batchId: BATCH, bankRowCount: 1 });
    expect((mockSql.mock.calls[1]![0] as string[]).join('?')).toMatch(/sync_date_from, sync_date_to/);
    expect(mockSql.mock.calls[1]!.slice(1)).toEqual(expect.arrayContaining(['2026-10-01', '2026-10-31']));
  });
});

describe('writeBankRows', () => {
  const planned = (n: number) => ({
    bankTransactionId: row(n).bank_id, transactionDate: '2026-10-02', amount: -100, description: 'x',
    old: { cc1Id: null, cc2Id: null, buId: null }, next: { cc1Id: F1, cc2Id: P1, buId: null }, blanks: [] as never[],
  });

  it('throws when fewer rows were written than planned, saying how many', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: row(1).bank_id }]);
    await expect(writeBankRows(COMPANY, BATCH, [planned(1), planned(2)]))
      .rejects.toMatchObject({ code: 'BANK_DIMENSION_SYNC_REFUSED', message: expect.stringMatching(/^1 bank transaction\(s\) were changed by another request/) });
  });

  it('writes nothing for no rows', async () => {
    expect(await writeBankRows(COMPANY, BATCH, [])).toBe(0);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
