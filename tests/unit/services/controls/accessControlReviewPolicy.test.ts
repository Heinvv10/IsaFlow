import {expect,it} from 'vitest';
import {reviewAccessSubject,type AccessSubject} from '@/modules/accounting/services/controls/accessControlReviewPolicy';
import type {ModulePermission} from '@/lib/auth/permissionService';
const now='2026-09-10T01:00:00.000Z';
const subject=(patch:Partial<AccessSubject>={}):AccessSubject=>({id:'subject',personId:'person',kind:'membership',oauthAppActive:true,role:'owner',profile:{is_active:true,status:'active',suspended_at:null},scopes:null,overrides:[],createdAt:'2025-01-01T00:00:00Z',lastUsedAt:null,revokedAt:null,accessExpiresAt:null,refreshExpiresAt:null,...patch});
const override=(patch:Partial<ModulePermission>={}):ModulePermission=>({moduleKey:'banking',moduleName:'banking',canRead:false,canWrite:false,canDelete:false,canExport:false,canApprove:false,accountRangeFrom:null,accountRangeTo:null,restrictions:{},...patch});
it('uses current policy for owner denial and viewer ceiling without impersonating reviewed people',()=>{
 const owner=reviewAccessSubject(subject({overrides:[override()]}),now,90);
 expect(owner.permissions).not.toContain('read:bank-tx');expect(owner.denied).toContainEqual({permission:'read:bank-tx',reason:'MODULE_DENIED',conditional:false});
 expect(reviewAccessSubject(subject({role:'viewer'}),now,90).permissions).not.toContain('write:post');
});
it('separates stored scope, dependency denial and conditional rights from executable permissions',()=>{
 const value=reviewAccessSubject(subject({kind:'pat',scopes:['write:accounts','read:payroll-sensitive','unrecognised'],accessExpiresAt:'2027-01-01T00:00:00Z',overrides:[override({moduleKey:'accounts',canWrite:true,canRead:true,accountRangeFrom:'1000'})]}),now,90);
 expect(value.permissions).toEqual([]);expect(value.denied).toContainEqual({permission:'write:accounts',reason:'ENTITY_REQUIRED',conditional:true});
 expect(value.denied).toContainEqual({permission:'read:payroll-sensitive',reason:'MISSING_SCOPE',conditional:false});expect(value.findings).toContain('unsupported_granted_scope');
});
it('retains expired OAuth refresh eligibility separately from current access and observed dormancy',()=>{
 const value=reviewAccessSubject(subject({kind:'oauth',scopes:['read:bank-tx'],accessExpiresAt:'2026-01-01T00:00:00Z',refreshExpiresAt:'2027-01-01T00:00:00Z'}),now,90);
 expect(value.permissions).toEqual([]);expect(value.refreshEligible).toBe(true);expect(value.standingReasons).toContain('access_expired');expect(value.dormancy).toBe('never_observed');
 expect(reviewAccessSubject(subject({kind:'pat',scopes:['read:bank-tx'],accessExpiresAt:'2027-01-01T00:00:00Z',lastUsedAt:now}),now,90).dormancy).toBe('recently_observed');
});
it('fails closed on absent profiles, missing membership, revoked credentials and duplicate overrides',()=>{
 for(const patch of [{profile:null},{role:null},{kind:'pat' as const,scopes:['read:bank-tx'],revokedAt:now}])expect(reviewAccessSubject(subject(patch),now,90).permissions).toEqual([]);
 const duplicate=reviewAccessSubject(subject({overrides:[override({canRead:true}),override({canRead:true})]}),now,90);
 expect(duplicate.permissions).not.toContain('read:bank-tx');expect(duplicate.findings).toContain('duplicate_module_override');
});
it('does not advertise refresh for a revoked OAuth app even when its grant refresh expiry is future',()=>{
 const row={...subject({kind:'oauth',scopes:['read:bank-tx'],accessExpiresAt:'2027-01-01T00:00:00Z',refreshExpiresAt:'2027-01-01T00:00:00Z'}),oauthAppActive:false};
 const result=reviewAccessSubject(row,now,90);expect(result.refreshEligible).toBe(false);
 // Existing access-token validation checks the grant, while refresh also checks the app.
 expect(result.permissions).toContain('read:bank-tx');expect(result.findings).toContain('oauth_app_revoked_or_missing');
});
