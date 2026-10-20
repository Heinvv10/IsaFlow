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

// Every line a name pattern can name.
const CODES = ['IS002', 'IS013', 'IS010', 'IS042', 'IS109', 'IS160', 'IS171', 'IS183', 'IS195', 'IS201', 'IS204',
  'IS219', 'IS225', 'IS234', 'IS240', 'IS258', 'IS279', 'IS291', 'IS297', 'IS351', 'IS360', 'IS378', 'IS381',
  'IS393', 'IS330', 'IS398', 'IS401', 'IS422', 'IS443', 'IS454', 'IS461', 'IS463', 'IS484', 'BS043', 'BS045',
  'BS053', 'BS055', 'BS011', 'BS028', 'BS065', 'BS031', 'BS026', 'BS070', 'BS069', 'BS032', 'BS066'];
const LINES = CODES.map((code) => ({ code, label: code }));

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

  // One name per pattern, with the type it is for, and a type it is not for.
  const TABLE: Array<[name: string, type: string, code: string, wrongType: string]> = [
    ['Turnover', 'revenue', 'IS002', 'asset'], ['Management fees received', 'revenue', 'IS013', 'liability'],
    ['Rent received', 'revenue', 'IS010', 'asset'], ['Cost of sales', 'expense', 'IS042', 'liability'],
    ['Subcontractors', 'expense', 'IS109', 'liability'], ['Accounting fees', 'expense', 'IS160', 'liability'],
    ['Auditors remuneration', 'expense', 'IS171', 'liability'], ['Bank charges', 'expense', 'IS183', 'liability'],
    ['Cleaning', 'expense', 'IS195', 'asset'], ['Computer expenses', 'expense', 'IS201', 'asset'],
    ['Consultants', 'expense', 'IS204', 'liability'], ['Depreciation', 'expense', 'IS219', 'asset'],
    ['Directors remuneration', 'expense', 'IS225', 'liability'], ['Donations', 'expense', 'IS234', 'liability'],
    ['Entertainment', 'expense', 'IS240', 'liability'], ['Insurance', 'expense', 'IS258', 'liability'],
    ['Legal fees', 'expense', 'IS279', 'liability'], ['Members remuneration', 'expense', 'IS291', 'liability'],
    ['Motor vehicle expenses', 'expense', 'IS297', 'asset'], ['Rent paid', 'expense', 'IS351', 'liability'],
    ['Repairs and maintenance', 'expense', 'IS360', 'liability'], ['Wages', 'expense', 'IS378', 'liability'],
    ['Security', 'expense', 'IS381', 'asset'], ['Staff welfare', 'expense', 'IS393', 'liability'],
    ['Stationery', 'expense', 'IS330', 'asset'], ['Subscriptions', 'expense', 'IS398', 'liability'],
    ['Telephone', 'expense', 'IS401', 'liability'], ['Travel', 'expense', 'IS422', 'liability'],
    ['Water and electricity', 'expense', 'IS443', 'liability'], ['Interest paid', 'expense', 'IS454', 'liability'],
    ['Interest received', 'revenue', 'IS461', 'asset'], ['Dividends received', 'revenue', 'IS463', 'liability'],
    ['Dividends paid', 'equity', 'IS484', 'liability'], ['Share capital', 'equity', 'BS043', 'expense'],
    ['Retained earnings', 'equity', 'BS045', 'revenue'], ['Shareholders loan', 'liability', 'BS053', 'expense'],
    ['Members loan', 'liability', 'BS055', 'expense'], ['Shareholder loan receivable', 'asset', 'BS011', 'expense'],
    ['Trade receivables', 'asset', 'BS028', 'revenue'], ['Trade payables', 'liability', 'BS065', 'expense'],
    ['Prepayments', 'asset', 'BS031', 'expense'], ['Inventory', 'asset', 'BS026', 'expense'],
    ['Bank overdraft', 'liability', 'BS070', 'expense'], ['Taxation payable', 'liability', 'BS069', 'expense'],
    ['Taxation receivable', 'asset', 'BS032', 'expense'], ['Accrued expenses', 'liability', 'BS066', 'expense'],
  ];

  it.each(TABLE)('%s: a %s account goes to %s, a %s one to nothing', async (name, type, code, wrongType) => {
    expect(await outcome(acct(name, type), acct(name, wrongType))).toEqual([code, null]);
  });

  it('suggests, never maps, a loan TO a shareholder or member (an asset)', async () => {
    q.getUnmappedAccounts.mockResolvedValueOnce([acct('Shareholder loan - Blitz Fibre', 'asset')]);
    const result = await autoMapAccounts('c');
    expect(q.mapAccount).not.toHaveBeenCalled();
    expect(result.suggestions.map((x) => x.suggestedCode)).toEqual(['BS011']);
  });

  it('leaves an equity dividends account unmapped on a taxonomy without IS484', async () => {
    q.getStatementLines.mockResolvedValueOnce(LINES.filter((l) => l.code !== 'IS484'));
    expect(await outcome(acct('Dividends declared', 'equity'))).toEqual([null]);
  });
});
