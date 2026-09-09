import { expect, it } from 'vitest';
import { permissionReason } from '@/lib/auth/effectivePermissionPolicy';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';
import { SCOPE_LABELS } from '@/lib/auth/consentScopeLabels';
import { partitionRequestedScopes } from '@/lib/auth/consentScopes';
it('requires explicit import consent independently of exception and journal permissions', () => {
  expect(permissionReason('admin', 'write:imports', ['write:imports'], [])).toBeNull();
  expect(permissionReason('admin', 'write:imports', ['write:controls', 'write:journals', 'write:post'], [])).toBe('MISSING_SCOPE');
  expect(partitionRequestedScopes(['read:imports', 'write:imports'])).toEqual({autoGranted:['read:imports'],optIn:['write:imports']});
});
it('requires a deliberate manager import grant and refuses viewer writes', () => {
  expect(permissionReason('manager', 'write:imports', ['write:imports'], [])).toBe('MODULE_DENIED');
  expect(permissionReason('viewer', 'write:imports', ['write:imports'], [])).toBe('ROLE_CEILING');
  expect(permissionReason('admin', 'read:imports', ['read:imports'], [])).toBeNull();
});
it('publishes the same import consent vocabulary for PAT and OAuth', () => {
  for (const scope of ['read:imports', 'write:imports']) {
    expect(PAT_SCOPES).toContain(scope); expect(OAUTH_SCOPES).toContain(scope);
    expect(SCOPE_LABELS[scope]).toContain('import');
  }
});
