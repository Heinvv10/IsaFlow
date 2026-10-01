/**
 * The MCP account tools must hand the agent the role guards' own wording.
 *
 * `deactivate_gl_account` used to catch a role-lock timeout and RETURN a tool
 * error: the 55P03 had already aborted the registry's savepoint, so its RELEASE
 * failed and the agent got the generic failure, not "retry in a moment". A
 * timeout is now re-thrown — the registry rolls the savepoint back and keeps
 * the message of a thrown refusal whose code is allow-listed.
 * `update_gl_account` let the reactivation refusal escape as a bare Error
 * (generic failure again); it is answered as a tool error before any write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getAccountById: vi.fn(async () => ({ id: ACCOUNT, isActive: true })),
  updateAccount: vi.fn(async () => ({ id: ACCOUNT })),
  createAccount: vi.fn(), deleteAccount: vi.fn(), getChartOfAccounts: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/accountReclassifyService', () => ({
  reclassifyAccount: vi.fn(), ReclassifyError: class extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/systemRoleReactivation', () => ({ reactivationRefusal: vi.fn(async () => null) }));

import { deactivateGlAccountTool, updateGlAccountTool } from '@/lib/mcp/tools/writeGlAccounts';
import { deleteAccount, updateAccount } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { reclassifyAccount } from '@/modules/accounting/services/gl/accountReclassifyService';
import { reactivationRefusal } from '@/modules/accounting/services/gl/systemRoleReactivation';
import { SystemRoleLockTimeoutError } from '@/modules/accounting/services/gl/systemRoleWriteLock';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import type { McpToolContext } from '@/lib/mcp/types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ctx = { companyId: '22222222-2222-4222-8222-222222222222', userId: 'u' } as unknown as McpToolContext;

beforeEach(() => vi.clearAllMocks());

describe('MCP account tools and the role guards', () => {
  it('deactivate_gl_account re-throws a role-lock timeout, with the retry wording the registry keeps', async () => {
    vi.mocked(deleteAccount).mockRejectedValueOnce(new SystemRoleLockTimeoutError());
    const thrown = await deactivateGlAccountTool.handler({ account_id: ACCOUNT, idempotency_key: 'k' }, ctx).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(SystemRoleLockTimeoutError);
    expect(safeErrorText(thrown, 'generic')).toMatch(/retry in a moment/);
  });

  it('deactivate_gl_account still answers an ordinary refusal as a tool error', async () => {
    vi.mocked(deleteAccount).mockRejectedValueOnce(new Error('Cannot delete "Bank" — it is a system account'));
    const out = await deactivateGlAccountTool.handler({ account_id: ACCOUNT, idempotency_key: 'k' }, ctx);
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('it is a system account') }] });
  });

  it('update_gl_account answers the reactivation refusal with its own text, before any write', async () => {
    vi.mocked(reactivationRefusal).mockResolvedValueOnce('Cannot reactivate system account 1105: account 1110 now holds the bank role.');
    const out = await updateGlAccountTool.handler(
      { account_id: ACCOUNT, is_active: true, account_subtype: 'other', idempotency_key: 'k' }, ctx);
    expect(out).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('1110 now holds the bank role') }] });
    expect(reclassifyAccount).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
  });
});
