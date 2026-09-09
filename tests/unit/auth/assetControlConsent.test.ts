import {expect,it} from 'vitest';
import {permissionReason} from '@/lib/auth/effectivePermissionPolicy';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {OAUTH_SCOPES} from '@/lib/auth/oauthScopes';
import {partitionRequestedScopes} from '@/lib/auth/consentScopes';
it('makes fixed asset scopes usable by the actual permission resolver',()=>{
 for(const scope of ['read:assets','write:assets']){
  expect(permissionReason('owner',scope,[scope],[])).toBeNull();
  expect(PAT_SCOPES).toContain(scope);expect(OAUTH_SCOPES).toContain(scope);
 }
 expect(permissionReason('owner','write:assets',['write:post'],[])).toBe('MISSING_SCOPE');
 expect(permissionReason('viewer','write:assets',['write:assets'],[])).toBe('ROLE_CEILING');
});
it('requires explicit consent for changing fixed assets',()=>{
 expect(partitionRequestedScopes(['read:assets','write:assets'])).toEqual({autoGranted:['read:assets'],optIn:['write:assets']});
});
