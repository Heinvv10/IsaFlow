/** Pins the refusal REASON at each throw site: the MCP reply is chosen by it. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/auth/effectivePermissionQueries', async importOriginal => ({
  ...await importOriginal<object>(), loadPermissionState: state.load,
}));
import { assertEffectivePermission, EffectivePermissionError } from '@/lib/auth/effectivePermissions';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const override = (moduleKey: string, extra: Record<string, unknown>) => ({ moduleKey, canRead: true, canWrite: true, canApprove: true,
  accountRangeFrom: null, accountRangeTo: null, restrictions: {}, ...extra });
async function reason(permission: string, ctx: Partial<ControlTx>, entity?: { entityType: string; entityId: string }) {
  const error = await assertEffectivePermission(ctx as ControlTx, permission, entity).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(EffectivePermissionError);
  return (error as EffectivePermissionError).reason;
}
beforeEach(() => { vi.clearAllMocks(); });
describe('account-range and restriction refusals', () => {
  it('a constrained override on anything but a gl_account write is ENTITY_REQUIRED', async () => {
    state.load.mockResolvedValue({ role: 'admin', scopes: null, overrides: [override('banking', { restrictions: { only: 'x' } })] });
    expect(await reason('write:bank-tx', {})).toBe('ENTITY_REQUIRED');
  });
  it('an account checked and found outside the permitted range is ACCOUNT_OUT_OF_RANGE', async () => {
    state.load.mockResolvedValue({ role: 'admin', scopes: null, overrides: [override('accounts', { accountRangeFrom: '1000', accountRangeTo: '1999' })] });
    const sql = vi.fn(async () => [{ account_code: '5000' }]);
    expect(await reason('write:accounts', { principal: { companyId: 'c' } as ControlTx['principal'], sql: sql as unknown as ControlTx['sql'] },
      { entityType: 'gl_account', entityId: '11111111-1111-4111-8111-111111111111' })).toBe('ACCOUNT_OUT_OF_RANGE');
  });
  it('a missing token scope is MISSING_SCOPE', async () => {
    state.load.mockResolvedValue({ role: 'admin', scopes: ['read:reports'], overrides: [] });
    expect(await reason('write:bank-tx', {})).toBe('MISSING_SCOPE');
  });
});
import { permissionRefusalMessage } from '@/lib/mcp/scopeRemediation';
describe('the reply each account-constraint reason gets', () => {
  it('an unchecked constraint asks for it to be removed', () => {
    const text = permissionRefusalMessage('write:bank-tx', 'ENTITY_REQUIRED');
    expect(text).toMatch(/remove/i);
    expect(text).not.toMatch(/widen/i);
  });
  it('an account outside the range asks for the range to be widened', () => {
    const text = permissionRefusalMessage('write:accounts', 'ACCOUNT_OUT_OF_RANGE');
    expect(text).toMatch(/widen/i);
    expect(text).toMatch(/range/i);
    expect(text).not.toMatch(/remove/i);
  });
});
