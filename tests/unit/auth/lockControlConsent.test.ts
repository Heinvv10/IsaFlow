import {expect,it} from 'vitest';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {OAUTH_SCOPES} from '@/lib/auth/oauthScopes';
import {partitionRequestedScopes,buildGrantedScopes} from '@/lib/auth/consentScopes';
import {permissionReason} from '@/lib/auth/effectivePermissionPolicy';
it('requires explicit new consent for lock mutations',()=>{
  expect(PAT_SCOPES).toContain('write:locks');expect(OAUTH_SCOPES).toContain('write:locks');
  const split=partitionRequestedScopes(['read:reports','write:locks']);
  expect(split).toEqual({autoGranted:['read:reports'],optIn:['write:locks']});
  expect(buildGrantedScopes(split.autoGranted,split.optIn,{})).toEqual(['read:reports']);
});
it('does not expand exception scopes and requires explicit manager authority',()=>{
  expect(permissionReason('owner','write:locks',['write:controls'],[])).toBe('MISSING_SCOPE');
  expect(permissionReason('owner','write:locks',['write:locks'],[])).toBeNull();
  expect(permissionReason('manager','write:locks',['write:locks'],[])).toBe('MODULE_DENIED');
  expect(permissionReason('viewer','write:locks',['write:locks'],[])).toBe('ROLE_CEILING');
});
