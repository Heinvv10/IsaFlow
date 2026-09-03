/**
 * `get_opening_balances` — the read side that never existed.
 *
 * `set_opening_balance` posts a journal AND writes
 * `gl_accounts.bank_opening_balance`, deliberately, because the column is
 * display metadata that `getBankAccountsStatus` never adds to a balance:
 * writing it alone shows the right number on the screen a person checks while
 * the trial balance and every reconciliation stay wrong.
 *
 * Which means the two CAN disagree — the column is editable from the
 * bank-account editor with no journal behind it — and until now nothing could
 * read either back. The disagreement is the finding this report exists to make
 * visible, so it is reported as a field, not resolved into one number.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { getOpeningBalances } from '@/modules/accounting/services/gl/openingBalanceReadService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function sqlText(i = 0): string {
  const parts = mockSql.mock.calls[i]?.[0] as TemplateStringsArray | undefined;
  return (parts ?? ([] as unknown as TemplateStringsArray)).join(' ? ');
}

const ROWS = [
  {
    id: 'acc-1', account_code: '1110', account_name: 'Bank - Primary',
    account_subtype: 'bank', is_active: true,
    posted_amount: '5000.00', posted_as_at: '2025-03-01',
    journal_entry_ids: ['je-1'], entry_numbers: ['JE-0001'],
    metadata_amount: '5000.00', metadata_as_at: '2025-03-01',
    posted_through: '2025-03-02T09:00:00.000Z',
  },
  {
    id: 'acc-2', account_code: '1120', account_name: 'Paycard',
    account_subtype: 'bank', is_active: true,
    posted_amount: null, posted_as_at: null,
    journal_entry_ids: [], entry_numbers: [],
    metadata_amount: '1200.00', metadata_as_at: '2025-04-01',
    posted_through: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue(ROWS);
});

describe('getOpeningBalances', () => {
  it('reports the posted journal and the display metadata SEPARATELY', async () => {
    const result = await getOpeningBalances(COMPANY);
    expect(result.rows[0]).toMatchObject({
      accountCode: '1110',
      postedAmount: 5000,
      metadataAmount: 5000,
      agrees: true,
    });
  });

  it('flags the account whose metadata has no journal behind it', async () => {
    // The banking screen shows R1,200 and the ledger has never seen it. This
    // is the exact state set_opening_balance exists to prevent and the
    // bank-account editor can still create.
    const result = await getOpeningBalances(COMPANY);
    expect(result.rows[1]).toMatchObject({
      postedAmount: null,
      metadataAmount: 1200,
      agrees: false,
    });
    expect(result.disagreements.map((r) => r.accountCode)).toEqual(['1120']);
  });

  it('counts an account with neither as having no opening balance, not a disagreement', async () => {
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1130', account_name: 'New', account_subtype: 'bank', is_active: true,
        posted_amount: null, posted_as_at: null, journal_entry_ids: [], entry_numbers: [],
        metadata_amount: null, metadata_as_at: null, posted_through: null },
    ]);
    const result = await getOpeningBalances(COMPANY);
    expect(result.rows[0]!.agrees).toBe(true);
    expect(result.disagreements).toEqual([]);
    expect(result.accountsWithoutOpeningBalance).toEqual(['1130']);
  });

  it('reads a stored 0.00 as "not set" — the column defaults to zero, not NULL', async () => {
    // Every one of Velocity's 81 bank accounts carries 0.00 today because that
    // is the column default. set_opening_balance refuses a zero amount, so a
    // stored zero can only mean nobody has set one.
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1544331', account_name: 'ABSA', account_subtype: 'bank', is_active: true,
        posted_amount: null, posted_as_at: null, journal_entry_ids: [], entry_numbers: [],
        metadata_amount: '0.00', metadata_as_at: null, posted_through: null },
    ]);
    const result = await getOpeningBalances(COMPANY);
    expect(result.accountsWithoutOpeningBalance).toEqual(['1544331']);
    expect(result.disagreements).toEqual([]);
  });

  it('treats a sub-cent difference as agreement and a real one as not', async () => {
    mockSql.mockResolvedValue([
      { id: 'x', account_code: '1', account_name: 'A', account_subtype: 'bank', is_active: true,
        posted_amount: '100.004', posted_as_at: '2025-03-01', journal_entry_ids: ['j'], entry_numbers: ['JE-1'],
        metadata_amount: '100.00', metadata_as_at: '2025-03-01', posted_through: null },
      { id: 'y', account_code: '2', account_name: 'B', account_subtype: 'bank', is_active: true,
        posted_amount: '100.02', posted_as_at: '2025-03-01', journal_entry_ids: ['j'], entry_numbers: ['JE-2'],
        metadata_amount: '100.00', metadata_as_at: '2025-03-01', posted_through: null },
    ]);
    const result = await getOpeningBalances(COMPANY);
    expect(result.rows[0]!.agrees).toBe(true);
    expect(result.rows[1]!.agrees).toBe(false);
  });

  it('offers a route to the journals behind every posted figure', async () => {
    const result = await getOpeningBalances(COMPANY);
    expect(result.rows[0]!.journalEntryIds).toEqual(['je-1']);
    expect(result.rows[0]!.entryNumbers).toEqual(['JE-0001']);
  });

  it('scopes by company_id and selects the opening-balance journal source', async () => {
    await getOpeningBalances(COMPANY);
    expect(sqlText()).toMatch(/company_id/);
    expect(sqlText()).toMatch(/auto_migration/);
    expect(mockSql.mock.calls[0]?.slice(1)).toContain(COMPANY);
  });

  it('does NOT filter on is_active', async () => {
    await getOpeningBalances(COMPANY);
    expect(sqlText()).not.toMatch(/is_active\s*=/);
  });

  it('totals the posted opening balances', async () => {
    const result = await getOpeningBalances(COMPANY);
    expect(result.totals).toEqual({ posted: 5000, metadata: 6200 });
  });

  it('reports posted_through from the journals, never now()', async () => {
    const result = await getOpeningBalances(COMPANY);
    expect(result.postedThrough).toBe('2025-03-02T09:00:00.000Z');
    expect(sqlText()).not.toMatch(/\bnow\(\)/i);
  });

  it('narrows to one account when asked', async () => {
    await getOpeningBalances(COMPANY, 'acc-1');
    expect(mockSql.mock.calls[0]?.slice(1)).toContain('acc-1');
  });
});
