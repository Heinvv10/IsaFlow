import { describe, expect, it, vi } from 'vitest';
import { assertControlTx } from '@/modules/accounting/services/controls/context';
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ModulePermission } from '@/lib/auth/permissionService';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { assertEffectivePermission, resolveEffectivePermissions, attenuateGrantedScopes,
  EFFECTIVE_PERMISSION_RULES } from '@/lib/auth/effectivePermissions';

function override(moduleKey: string, values: Partial<ModulePermission> = {}): ModulePermission {
  return { moduleKey, moduleName: moduleKey, canRead: true, canWrite: true, canDelete: true,
    canExport: true, canApprove: true, accountRangeFrom: null, accountRangeTo: null,
    restrictions: {}, ...values };
}
function fixture(role = 'admin', authMethod: ControlTx['principal']['authMethod'] = 'pat') {
  const state = { membership: [{ role, is_active: true, status: 'active', suspended_at: null,
    company_status: 'active', company_suspended_at: null }], overrides: [] as ModulePermission[],
    accounts: [{ account_code: '1500' }], grants: [{ scopes: [...PAT_SCOPES], valid: true }] };
  const sql = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('company_user_permissions')) return state.overrides.map(p => ({
      module_key: p.moduleKey, can_read: p.canRead, can_write: p.canWrite,
      can_delete: p.canDelete, can_export: p.canExport, can_approve: p.canApprove,
      account_range_from: p.accountRangeFrom, account_range_to: p.accountRangeTo, restrictions: p.restrictions,
    }));
    if (text.includes('gl_accounts')) return state.accounts;
    if (text.includes('personal_access_tokens') || text.includes('oauth_authorisations')) return state.grants;
    return state.membership;
  });
  const ctx: ControlTx = { sql, principal: { companyId: 'company-a', personId: 'alice',
    connectionId: 'token-1', grantId: 'grant-1', actingFirmId: null, requestId: 'request-1',
    operationId: 'operation-1', authMethod, provenance: authMethod === 'cookie' ? 'human' : 'agent',
    delegatedByPersonId: null, grantedScopes: [...PAT_SCOPES, 'write:approvals', 'write:beneficiaries',
      'read:payroll-sensitive', 'read:access', 'read:audit', 'write:audit', 'write:controls', 'read:approvals'] } };
  if (authMethod === 'cookie') ctx.principal.grantedScopes = null;
  return { ctx, state, sql };
}

describe('effective permission policy', () => {
  it('maps all existing and planned scopes explicitly', () => {
    for (const scope of [...PAT_SCOPES, 'read:approvals', 'write:approvals', 'write:beneficiaries',
      'read:access', 'read:audit', 'write:audit', 'write:controls', 'read:payroll-sensitive']) {
      expect(EFFECTIVE_PERMISSION_RULES).toHaveProperty(scope);
    }
  });
  it('hard caps viewer despite stale custom grants and denies unknown roles/scopes', () => {
    expect(attenuateGrantedScopes('viewer', ['write:journals', 'read:reports'], [override('accounts')]))
      .toEqual(['read:reports']);
    expect(attenuateGrantedScopes('mystery', [...PAT_SCOPES], [])).toEqual([]);
    expect(attenuateGrantedScopes('admin', ['write:invented'], [])).toEqual([]);
  });
  it('honours explicit denies for owners and admins', () => {
    for (const role of ['owner', 'admin']) {
      expect(attenuateGrantedScopes(role, ['write:journals'], [override('accounts', { canWrite: false })]))
        .toEqual([]);
    }
  });
  it('requires manager forensic capability while preserving ordinary writes', () => {
    const grants = ['write:contacts', 'write:approvals', 'write:beneficiaries', 'read:payroll-sensitive', 'read:payroll'];
    expect(attenuateGrantedScopes('manager', grants, [])).toEqual(['write:contacts', 'read:payroll']);
    expect(attenuateGrantedScopes('manager', grants, [override('approvals'), override('beneficiaries'),
      override('payroll_sensitive')])).toEqual(grants);
  });
  it('requires both payroll read and sensitive scopes', () => {
    expect(attenuateGrantedScopes('admin', ['read:payroll-sensitive'], [])).toEqual([]);
    expect(attenuateGrantedScopes('admin', ['read:payroll', 'read:payroll-sensitive'],
      [override('payroll', { canRead: false })])).toEqual([]);
  });
  it('does not advertise restricted rights as unrestricted', () => {
    expect(attenuateGrantedScopes('admin', ['write:journals'],
      [override('accounts', { accountRangeFrom: '1000' })])).toEqual([]);
  });
});

describe('current transaction permission resolution', () => {
  it('rejects unissued transaction context before reading SQL', async () => {
    const { ctx, sql } = fixture();
    vi.mocked(assertControlTx).mockImplementationOnce(() => { throw new Error('Unissued context'); });
    await expect(resolveEffectivePermissions(ctx)).rejects.toThrow('Unissued context');
    expect(sql).not.toHaveBeenCalled();
  });
  it('rechecks the same token after a role downgrade', async () => {
    const { ctx, state } = fixture();
    await expect(assertEffectivePermission(ctx, 'write:journals')).resolves.toBeUndefined();
    state.membership[0]!.role = 'viewer';
    state.overrides.push(override('accounts'));
    await expect(assertEffectivePermission(ctx, 'write:journals')).rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
    await expect(assertEffectivePermission(ctx, 'read:reports')).resolves.toBeUndefined();
  });
  it.each(['cookie', 'pat', 'oauth'] as const)('resolves %s permissions with grant ceiling', async method => {
    const { ctx } = fixture('admin', method);
    ctx.principal.grantedScopes = method === 'cookie' ? null : ['read:reports'];
    expect((await resolveEffectivePermissions(ctx)).permissions.includes('write:journals')).toBe(method === 'cookie');
    if (method !== 'cookie') {
      ctx.principal.grantedScopes = null;
      await expect(assertEffectivePermission(ctx, 'read:reports')).rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
    }
  });
  it.each(['pat', 'oauth'] as const)('rejects revoked/expired/reduced %s grants and missing identities', async method => {
    const { ctx, state } = fixture('admin', method);
    await expect(assertEffectivePermission(ctx, 'write:journals')).resolves.toBeUndefined();
    state.grants[0]!.scopes = ['read:reports'];
    await expect(assertEffectivePermission(ctx, 'write:journals')).rejects.toThrow();
    state.grants[0]!.valid = false;
    await expect(assertEffectivePermission(ctx, 'read:reports')).rejects.toThrow();
    state.grants = [];
    await expect(assertEffectivePermission(ctx, 'read:reports')).rejects.toThrow();
    ctx.principal.connectionId = null; ctx.principal.grantId = null;
    await expect(assertEffectivePermission(ctx, 'read:reports')).rejects.toThrow();
  });
  it('rejects jobs until a persisted delegation resolver exists', async () => {
    await expect(assertEffectivePermission(fixture('admin', 'job').ctx, 'read:reports')).rejects.toThrow();
  });
  it.each(['missing', 'inactive', 'suspended', 'status', 'company', 'companySuspended'])('rejects %s standing', async reason => {
    const { ctx, state } = fixture();
    if (reason === 'missing') state.membership = [];
    if (reason === 'inactive') state.membership[0]!.is_active = false;
    if (reason === 'suspended') Object.assign(state.membership[0]!, { suspended_at: new Date() });
    if (reason === 'status') state.membership[0]!.status = 'deleted';
    if (reason === 'company') state.membership[0]!.company_status = 'suspended';
    if (reason === 'companySuspended') Object.assign(state.membership[0]!, { company_suspended_at: new Date() });
    await expect(assertEffectivePermission(ctx, 'read:reports')).rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
  });
  it('requires owned account entity to evaluate ranges and denies unknown restrictions', async () => {
    const { ctx, state } = fixture();
    state.overrides.push(override('accounts', { accountRangeFrom: '1000', accountRangeTo: '1999' }));
    await expect(assertEffectivePermission(ctx, 'write:accounts')).rejects.toThrow();
    await expect(assertEffectivePermission(ctx, 'write:accounts', { entityType: 'gl_account', entityId: 'account-a' }))
      .resolves.toBeUndefined();
    state.accounts = [];
    await expect(assertEffectivePermission(ctx, 'write:accounts', { entityType: 'gl_account', entityId: 'foreign' }))
      .rejects.toThrow();
    state.accounts = [{ account_code: '9999' }];
    await expect(assertEffectivePermission(ctx, 'write:accounts', { entityType: 'gl_account', entityId: 'account-a' }))
      .rejects.toThrow();
    state.overrides[0]!.restrictions = { arbitrary: true };
    await expect(assertEffectivePermission(ctx, 'write:accounts', { entityType: 'gl_account', entityId: 'account-a' }))
      .rejects.toThrow();
  });
  it('does not bypass constraints inherited from prerequisite payroll read permission', async () => {
    const { ctx, state } = fixture('admin', 'cookie');
    state.overrides.push(override('payroll', { restrictions: { employees: ['alice'] } }));
    await expect(assertEffectivePermission(ctx, 'read:payroll-sensitive', { entityType: 'employee', entityId: 'bob' }))
      .rejects.toThrow();
  });
  it('uses tenant/person-bound locking queries and returns no token data', async () => {
    const { ctx, sql } = fixture();
    const result = await resolveEffectivePermissions(ctx);
    expect(sql.mock.calls.every(call => call.slice(1).includes('company-a'))).toBe(true);
    expect(sql.mock.calls.some(call => /FOR (?:UPDATE|SHARE)/.test(call[0].join('')))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('token-1');
    expect(JSON.stringify(result)).not.toContain('grantedScopes');
  });
});
