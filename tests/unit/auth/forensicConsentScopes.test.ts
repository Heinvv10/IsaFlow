import { expect, it } from 'vitest';
import { PAT_SCOPES } from '@/lib/auth/patScopes';
import { OAUTH_SCOPES } from '@/lib/auth/oauthScopes';
import { partitionRequestedScopes, buildGrantedScopes } from '@/lib/auth/consentScopes';
import { PAT_SCOPE_META } from '@/lib/auth/patScopeMeta';
import { SCOPE_LABELS } from '@/lib/auth/consentScopeLabels';
const added = ['read:approvals','write:approvals','write:beneficiaries','read:access',
  'read:audit','write:audit','write:controls','read:payroll-sensitive'];
const explicit = ['write:approvals','write:beneficiaries','write:audit','write:controls','read:payroll-sensitive'];
it.each(added)('publishes consistent PAT and OAuth consent for %s', scope => {
  expect(PAT_SCOPES).toContain(scope);
  expect(OAUTH_SCOPES).toContain(scope);
  expect(PAT_SCOPE_META).toHaveProperty(scope);
  expect(SCOPE_LABELS).toHaveProperty(scope);
});
it('requires explicit consent for every new write and sensitive payroll grant', () => {
  const parts = partitionRequestedScopes(added);
  expect(parts.optIn).toEqual(explicit);
  expect(buildGrantedScopes(parts.autoGranted, parts.optIn, {})).toEqual(['read:approvals','read:access','read:audit']);
  expect(buildGrantedScopes(parts.autoGranted, parts.optIn, {'write:approvals':true}))
    .toEqual(['read:approvals','read:access','read:audit','write:approvals']);
});
it('does not add grants when an old connection renews unchanged consent', () => {
  const old = ['read:reports','write:invoices'];
  const parts = partitionRequestedScopes(old);
  expect(buildGrantedScopes(parts.autoGranted, parts.optIn, Object.fromEntries(added.map(s => [s,true])))).toEqual(old);
});
