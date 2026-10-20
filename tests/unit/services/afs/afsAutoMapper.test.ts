/**
 * The AFS auto-mapper's name patterns only map an account of the type the line is for. They used to ignore the
 * type, so "Shareholders for dividend" (a liability) went to IS463 "Dividends received" and "Salaries payable"
 * to IS378 "Salaries and wages": a balance put on an income-statement line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({ getUnmappedAccounts: vi.fn(), getStatementLines: vi.fn(), mapAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/afs/afsMappingQueries', () => q);
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { autoMapAccounts } from '@/modules/accounting/services/afs/afsAutoMapper';

const LINES = ['IS002', 'IS258', 'IS378', 'IS463', 'IS484', 'BS031', 'BS043', 'BS053', 'BS065', 'BS066']
  .map((code) => ({ code, label: code }));

let n = 0;
const acct = (accountName: string, accountType: string, accountSubtype: string | null = null) =>
  ({ id: `a${++n}`, accountCode: String(1000 + n), accountName, accountType, accountSubtype });

/** The line each account was mapped to (high confidence) or suggested for (medium), or null. */
async function outcome(...accounts: ReturnType<typeof acct>[]) {
  q.getUnmappedAccounts.mockResolvedValueOnce(accounts);
  const result = await autoMapAccounts('c');
  const mapped = new Map(q.mapAccount.mock.calls.map(([, id, code]) => [id as string, code as string]));
  const suggested = new Map(result.suggestions.map((s) => [s.glAccountId, s.suggestedCode]));
  return accounts.map((a) => mapped.get(a.id) ?? suggested.get(a.id) ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  q.getStatementLines.mockResolvedValue(LINES);
  q.mapAccount.mockResolvedValue(undefined);
});

describe('autoMapAccounts name patterns respect the account type', () => {
  it('maps "dividend" by type: revenue to IS463, equity to IS484, a liability to nothing', async () => {
    expect(await outcome(
      acct('Dividends received', 'revenue'),
      acct('Dividends declared', 'equity'),
      acct('Shareholders for dividend', 'liability'),
      acct('Dividends receivable', 'asset'),
    )).toEqual(['IS463', 'IS484', null, null]);
  });

  it('does not put a liability or an asset on an expense line because of its name', async () => {
    expect(await outcome(
      acct('Salaries payable', 'liability'),
      acct('Salaries', 'expense'),
      acct('Insurance', 'expense'),
      acct('Prepaid insurance', 'asset'),
    )).toEqual([null, 'IS378', 'IS258', 'BS031']);
  });

  it('keeps balance-sheet patterns on balance-sheet types', async () => {
    expect(await outcome(
      acct('Share capital', 'equity'),
      acct('Shareholder loan', 'liability'),
      acct('Trade payables', 'liability'),
      acct('Accrued expenses', 'liability'),
      acct('Share capital fees', 'expense'),
    )).toEqual(['BS043', 'BS053', 'BS065', 'BS066', null]);
  });

  it('still lets a subtype mapping win over a name', async () => {
    expect(await outcome(acct('Sundry', 'revenue', 'revenue'))).toEqual(['IS002']);
  });
});
