import {expect,it} from 'vitest';
import {permissionReason} from '@/lib/auth/effectivePermissionPolicy';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {OAUTH_SCOPES} from '@/lib/auth/oauthScopes';
import {SCOPE_LABELS} from '@/lib/auth/consentScopeLabels';
import {partitionRequestedScopes} from '@/lib/auth/consentScopes';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
it('requires separate explicit current release authority',()=>{
 expect(permissionReason('admin','write:release',['write:release'],[])).toBeNull();
 expect(permissionReason('admin','write:release',['write:post'],[])).toBe('MISSING_SCOPE');
 expect(permissionReason('manager','write:release',['write:release'],[])).toBe('MODULE_DENIED');
 expect(permissionReason('viewer','write:release',['write:release'],[])).toBe('ROLE_CEILING');
 expect(PAT_SCOPES).toContain('write:release');expect(OAUTH_SCOPES).toContain('write:release');
 expect(partitionRequestedScopes(['read:bank-tx','write:release'])).toEqual({autoGranted:['read:bank-tx'],optIn:['write:release']});
 expect(SCOPE_LABELS['write:release']).toContain('independently approved');
});
it('separates financial batch posting from independently approved release',()=>{
 expect(operationPermission('supplier_payment_batch.process','write')).toBe('write:bank-tx');
 expect(operationRequiresPosting('supplier_payment_batch.process')).toBe(true);
 expect(operationPermission('payment_release.dispatch','write')).toBe('write:release');
 expect(operationRuleType('payment_release.dispatch')).toBe('payment_release');
 expect(operationRequiresPosting('payment_release.dispatch')).toBe(false);
});
