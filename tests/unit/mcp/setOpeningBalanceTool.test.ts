/**
 * set_opening_balance.
 *
 * The trap this tool avoids is the reason it posts a journal at all:
 * `gl_accounts.bank_opening_balance` is DISPLAY METADATA — `getBankAccountsStatus`
 * computes `balance` as `SUM(bt.amount)` and never adds it. Writing only that
 * column would show the right number on the banking screen while the trial
 * balance and every reconciliation stayed wrong, which is worse than doing
 * nothing because the screen a person checks would agree with them.
 *
 * So: the journal is the substance, the metadata is the echo, and the ORDER
 * between them is load-bearing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
  getAccountById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankOpeningBalanceService', () => ({
  setBankOpeningBalanceMeta: { read: vi.fn(), write: vi.fn() },
}));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { accountsBelongToCompany, getAccountById } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { setBankOpeningBalanceMeta } from '@/modules/accounting/services/bank/bankOpeningBalanceService';
import { setOpeningBalanceTool } from '@/lib/mcp/tools/writeOpeningBalance';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const CONTRA = '33333333-3333-4333-8333-333333333333';
const JE = '88888888-8888-4888-8888-888888888888';
const KEY = { idempotency_key: 'k1' };
const ARGS = {
  bank_account_id: BANK, contra_account_id: CONTRA,
  as_at: '2026-03-01', amount: 1500.5, ...KEY,
};

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:journals', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}
function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}
function linesOf(call = 0): JournalLineInput[] {
  return vi.mocked(createJournalEntry).mock.calls[call]![1].lines;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(getAccountById).mockResolvedValue({
    id: BANK, accountCode: '1150', accountName: 'Paycard 4765', accountSubtype: 'bank',
  } as never);
  vi.mocked(setBankOpeningBalanceMeta.read).mockResolvedValue({ amount: null, asAt: null });
  vi.mocked(createJournalEntry).mockResolvedValue({ id: JE } as never);
});

describe('set_opening_balance', () => {
  it('DEBITS the bank for a positive balance and credits the contra', async () => {
    const r = parseOk(await setOpeningBalanceTool.handler(ARGS, ctx()));
    expect(r.journal_entry_id).toBe(JE);

    const lines = linesOf();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ glAccountId: BANK, debit: 1500.5, credit: 0 });
    // The contra must be the CREDIT side. Getting this backwards still
    // BALANCES and still posts, so only an explicit both-fields assertion
    // catches it — a toMatchObject on the debit alone would not.
    expect(lines[1]).toMatchObject({ glAccountId: CONTRA, debit: 0, credit: 1500.5 });
  });

  it('flips both sides for an overdrawn (negative) balance', async () => {
    await setOpeningBalanceTool.handler({ ...ARGS, amount: -800 }, ctx());
    const lines = linesOf();
    expect(lines[0]).toMatchObject({ glAccountId: BANK, debit: 0, credit: 800 });
    expect(lines[1]).toMatchObject({ glAccountId: CONTRA, debit: 800, credit: 0 });
  });

  it('posts the journal AND stamps the agent — metadata alone would be a lie', async () => {
    await setOpeningBalanceTool.handler(ARGS, ctx());
    expect(postJournalEntry).toHaveBeenCalledWith(COMPANY, JE, ctx().userId);
    expect(vi.mocked(createJournalEntry).mock.calls[0]![3])
      .toEqual({ postingAgent: 'mcp:set_opening_balance:v1' });
    expect(vi.mocked(createJournalEntry).mock.calls[0]![1].source).toBe('auto_migration');
  });

  it('writes the metadata only AFTER the posting succeeds', async () => {
    // The reverse order leaves the banking screen showing a figure a failed
    // post never created.
    vi.mocked(postJournalEntry).mockRejectedValueOnce(new Error('period closed'));
    await expect(setOpeningBalanceTool.handler(ARGS, ctx())).rejects.toThrow('period closed');
    expect(setBankOpeningBalanceMeta.write).not.toHaveBeenCalled();
  });

  it('refuses a SECOND opening balance rather than stacking one', async () => {
    // Two of these both balance and both post; the account is then wrong by
    // exactly the first amount, with nothing flagging it.
    vi.mocked(setBankOpeningBalanceMeta.read).mockResolvedValue({ amount: 900, asAt: '2026-01-01' });
    const r = await setOpeningBalanceTool.handler(ARGS, ctx());
    expect(errText(r)).toContain('already has an opening balance');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses a zero amount — it would post nothing and report success', async () => {
    const r = await setOpeningBalanceTool.handler({ ...ARGS, amount: 0 }, ctx());
    expect(errText(r)).toContain('must not be zero');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses when contra equals the bank account', async () => {
    // Nets to nothing but still balances, so nothing downstream would catch it.
    const r = await setOpeningBalanceTool.handler({ ...ARGS, contra_account_id: BANK }, ctx());
    expect(errText(r)).toContain('must differ');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses an account whose subtype is not bank, and says how to fix it', async () => {
    vi.mocked(getAccountById).mockResolvedValue({
      id: BANK, accountCode: '1150', accountName: 'Paycard 4765', accountSubtype: undefined,
    } as never);
    const r = await setOpeningBalanceTool.handler(ARGS, ctx());
    expect(errText(r)).toContain('not a bank account');
    expect(errText(r)).toContain('update_gl_account');
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('checks BOTH ids against the token company in one batched call', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    expect(errText(await setOpeningBalanceTool.handler(ARGS, ctx()))).toBe('Not found');
    expect(vi.mocked(accountsBelongToCompany).mock.calls[0]![1]).toEqual([BANK, CONTRA]);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('has no default contra — it is required in the schema', () => {
    const schema = setOpeningBalanceTool.inputSchema as { required: string[] };
    expect(schema.required).toContain('contra_account_id');
    expect(setOpeningBalanceTool.requiresPost).toBe(true);
  });
});
