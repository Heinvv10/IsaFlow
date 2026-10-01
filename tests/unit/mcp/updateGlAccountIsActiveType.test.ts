/**
 * update_gl_account: `inputSchema` is not validated at runtime, so `is_active`
 * can arrive as "false" or 0. It used to be dropped silently — the call
 * answered success having changed nothing the agent asked for. It is refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getAccountById: vi.fn(async () => ({ id: ACCOUNT, isActive: true })),
  updateAccount: vi.fn(async () => ({ id: ACCOUNT })),
  createAccount: vi.fn(), deleteAccount: vi.fn(), getChartOfAccounts: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/accountReclassifyService', () => ({
  reclassifyAccount: vi.fn(), ReclassifyError: class extends Error {},
}));

import { updateGlAccountTool } from '@/lib/mcp/tools/writeGlAccounts';
import { updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { McpToolContext } from '@/lib/mcp/types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ctx = { companyId: '22222222-2222-4222-8222-222222222222', userId: 'u' } as unknown as McpToolContext;

beforeEach(() => vi.mocked(updateAccount).mockClear());

describe('update_gl_account is_active', () => {
  it.each(['false', 'true', 0, 1, null, [], {}])('refuses is_active: %j and writes nothing', async (value) => {
    const out = await updateGlAccountTool.handler({ account_id: ACCOUNT, is_active: value, idempotency_key: 'k' }, ctx);
    expect(out).toMatchObject({ isError: true, content: [{ text: 'invalid is_active' }] });
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('passes a real boolean through', async () => {
    const out = await updateGlAccountTool.handler({ account_id: ACCOUNT, is_active: false, idempotency_key: 'k' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(vi.mocked(updateAccount).mock.calls[0]![2]).toMatchObject({ isActive: false });
  });
});
