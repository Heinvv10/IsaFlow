/**
 * create_gl_account / update_gl_account / deactivate_gl_account.
 *
 * The behaviour worth pinning is not "it calls the service" — it is the four
 * places where a wrong answer is silent:
 *
 *  - `normal_balance` is derived, never accepted. An agent-supplied one
 *    inverts the account in every report while the row still looks valid.
 *  - `undefined` (leave alone) and `null` (clear) are different instructions
 *    all the way down. Collapsing them is exactly how parent_account_id became
 *    unclearable in the first place.
 *  - ownership is answered from a READ before any write, with the SAME text as
 *    a genuine miss.
 *  - reclassify refusals come back as a tool error, but a failure AFTER it has
 *    written must rethrow so the registry's savepoint unwinds it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  createAccount: vi.fn(),
  getAccountById: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/accountReclassifyService', async () => {
  // ReclassifyError is a real class here: the tool distinguishes it from every
  // other throw, and a stubbed sentinel would let that branch pass by accident.
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/gl/accountReclassifyService')>(
    '@/modules/accounting/services/gl/accountReclassifyService',
  );
  return { ReclassifyError: actual.ReclassifyError, reclassifyAccount: vi.fn() };
});

import {
  createAccount,
  getAccountById,
  updateAccount,
  deleteAccount,
} from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  reclassifyAccount,
  ReclassifyError,
} from '@/modules/accounting/services/gl/accountReclassifyService';
import {
  createGlAccountTool,
  updateGlAccountTool,
  deactivateGlAccountTool,
} from '@/lib/mcp/tools/writeGlAccounts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:accounts', 'write:post'],
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create_gl_account', () => {
  it('derives normal_balance from account_type and never takes it from the agent', async () => {
    vi.mocked(createAccount).mockResolvedValue({ id: ACCOUNT } as never);

    await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'Repairs', account_type: 'expense', ...KEY },
      ctx(),
    );
    expect(vi.mocked(createAccount).mock.calls[0]![1].normalBalance).toBe('debit');

    await createGlAccountTool.handler(
      { account_code: '4900', account_name: 'Rebates', account_type: 'revenue', ...KEY },
      ctx(),
    );
    expect(vi.mocked(createAccount).mock.calls[1]![1].normalBalance).toBe('credit');

    // The schema is the contract an agent reads. If normal_balance were
    // accepted at all, additionalProperties:false would not save us.
    const props = Object.keys(
      (createGlAccountTool.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    expect(props).not.toContain('normal_balance');
  });

  it('passes the token company, never one from args', async () => {
    vi.mocked(createAccount).mockResolvedValue({ id: ACCOUNT } as never);
    await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'X', account_type: 'expense', ...KEY },
      ctx(),
    );
    expect(vi.mocked(createAccount).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses an unknown account_type without querying anything', async () => {
    const r = await createGlAccountTool.handler(
      { account_code: '9', account_name: 'X', account_type: 'contra', ...KEY },
      ctx(),
    );
    expect(errText(r)).toContain('account_type must be one of');
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('answers a cross-tenant parent_account_id with the generic miss text', async () => {
    vi.mocked(getAccountById).mockResolvedValue(null);
    const r = await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'X', account_type: 'expense', parent_account_id: PARENT, ...KEY },
      ctx(),
    );
    // Not "belongs to another company" — that reply is an existence oracle.
    expect(errText(r)).toBe('Not found');
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('rejects a malformed parent_account_id before it can reach a ::UUID cast', async () => {
    const r = await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'X', account_type: 'expense', parent_account_id: 'abc', ...KEY },
      ctx(),
    );
    expect(errText(r)).toBe('invalid parent_account_id');
    expect(getAccountById).not.toHaveBeenCalled();
  });

  it('surfaces a service validation message but generic-ifies a pg error', async () => {
    vi.mocked(createAccount).mockRejectedValueOnce(new Error('Account code 5900 already exists'));
    const dup = await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'X', account_type: 'expense', ...KEY },
      ctx(),
    );
    expect(errText(dup)).toContain('already exists');

    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "gl_accounts_pkey"'), { code: '23505' });
    vi.mocked(createAccount).mockRejectedValueOnce(pgErr);
    const generic = await createGlAccountTool.handler(
      { account_code: '5900', account_name: 'X', account_type: 'expense', ...KEY },
      ctx(),
    );
    expect(errText(generic)).toBe('Failed to create account.');
    expect(errText(generic)).not.toContain('gl_accounts_pkey');
  });
});

describe('update_gl_account', () => {
  beforeEach(() => {
    vi.mocked(getAccountById).mockResolvedValue({ id: ACCOUNT, isActive: true } as never);
    vi.mocked(updateAccount).mockResolvedValue({ id: ACCOUNT } as never);
    vi.mocked(reclassifyAccount).mockResolvedValue({ id: ACCOUNT } as never);
  });

  it('an ABSENT key leaves the column alone; an explicit null CLEARS it', async () => {
    await updateGlAccountTool.handler({ account_id: ACCOUNT, account_name: 'Renamed', ...KEY }, ctx());
    // No classification keys sent → reclassify must not run at all, so a plain
    // rename never trips the cycle/leaf/orphan guards.
    expect(reclassifyAccount).not.toHaveBeenCalled();

    await updateGlAccountTool.handler({ account_id: ACCOUNT, parent_account_id: null, ...KEY }, ctx());
    expect(vi.mocked(reclassifyAccount).mock.calls[0]![2]).toEqual({ parentAccountId: null });

    await updateGlAccountTool.handler({ account_id: ACCOUNT, account_subtype: null, ...KEY }, ctx());
    expect(vi.mocked(reclassifyAccount).mock.calls[1]![2]).toEqual({ accountSubtype: null });
  });

  it('sets the bank subtype — the whole point of the tool', async () => {
    await updateGlAccountTool.handler({ account_id: ACCOUNT, account_subtype: 'bank', ...KEY }, ctx());
    expect(vi.mocked(reclassifyAccount).mock.calls[0]![2]).toEqual({ accountSubtype: 'bank' });
    expect(vi.mocked(reclassifyAccount).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('turns a reclassify refusal into a tool error, keeping its reason', async () => {
    vi.mocked(reclassifyAccount).mockRejectedValueOnce(
      new ReclassifyError('Parent 5000 has journal lines posted to it.'),
    );
    const r = await updateGlAccountTool.handler(
      { account_id: ACCOUNT, parent_account_id: PARENT, ...KEY },
      ctx(),
    );
    expect(errText(r)).toContain('journal lines posted');
    // Refused before writing, so the rename must not have happened either.
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('RETHROWS a non-refusal so the registry savepoint unwinds a partial write', async () => {
    vi.mocked(reclassifyAccount).mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    await expect(
      updateGlAccountTool.handler({ account_id: ACCOUNT, parent_account_id: PARENT, ...KEY }, ctx()),
    ).rejects.toThrow('deadlock detected');
  });

  it('RETHROWS an updateAccount failure — reclassify may already have written', async () => {
    vi.mocked(updateAccount).mockRejectedValueOnce(new Error('boom'));
    await expect(
      updateGlAccountTool.handler(
        { account_id: ACCOUNT, account_subtype: 'bank', account_name: 'X', ...KEY },
        ctx(),
      ),
    ).rejects.toThrow('boom');
  });

  it('answers an unowned account with the generic miss text, before any write', async () => {
    vi.mocked(getAccountById).mockResolvedValue(null);
    const r = await updateGlAccountTool.handler(
      { account_id: ACCOUNT, account_subtype: 'bank', ...KEY },
      ctx(),
    );
    expect(errText(r)).toBe('Not found');
    expect(reclassifyAccount).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
  });

  // A present-but-wrong-typed value is neither "leave alone" nor "clear".
  // Silently treating it as absent would return a SUCCESS envelope for an
  // instruction that was discarded — the agent reads that as confirmation the
  // field changed.
  it('refuses a wrong-typed account_subtype / parent_account_id instead of ignoring it', async () => {
    for (const args of [
      { account_id: ACCOUNT, account_subtype: 123, ...KEY },
      { account_id: ACCOUNT, account_subtype: ['bank'], ...KEY },
      { account_id: ACCOUNT, parent_account_id: 42, ...KEY },
      { account_id: ACCOUNT, parent_account_id: true, ...KEY },
    ]) {
      vi.clearAllMocks();
      vi.mocked(getAccountById).mockResolvedValue({ id: ACCOUNT, isActive: true } as never);
      const r = await updateGlAccountTool.handler(args, ctx());
      expect(errText(r)).toMatch(/invalid (account_subtype|parent_account_id)/);
      expect(reclassifyAccount).not.toHaveBeenCalled();
      expect(updateAccount).not.toHaveBeenCalled();
    }
  });

  it('refuses a call that would change nothing rather than issuing an empty UPDATE', async () => {
    const r = await updateGlAccountTool.handler({ account_id: ACCOUNT, ...KEY }, ctx());
    expect(errText(r)).toContain('Nothing to update');
    expect(updateAccount).not.toHaveBeenCalled();
  });
});

describe('deactivate_gl_account', () => {
  it('is idempotent on an already-inactive account and does not re-run the service', async () => {
    vi.mocked(getAccountById).mockResolvedValue({ id: ACCOUNT, isActive: false } as never);
    const r = parseOk(await deactivateGlAccountTool.handler({ account_id: ACCOUNT, ...KEY }, ctx()));
    expect(r.already_inactive).toBe(true);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('surfaces the service reason so the agent knows what to fix', async () => {
    vi.mocked(getAccountById).mockResolvedValue({ id: ACCOUNT, isActive: true } as never);
    vi.mocked(deleteAccount).mockRejectedValueOnce(
      new Error('Cannot delete "Paycard 12" — GL balance is R 1200.00.'),
    );
    const r = await deactivateGlAccountTool.handler({ account_id: ACCOUNT, ...KEY }, ctx());
    expect(errText(r)).toContain('GL balance is R 1200.00');
  });
});
