import {EFFECTIVE_PERMISSION_RULES,permissionReason} from '@/lib/auth/effectivePermissionPolicy';
import type {ModulePermission} from '@/lib/auth/permissionService';
import {isActiveUserAccount,type UserAccountRow} from '@/lib/auth/userAccountStatus';
export interface AccessSubject {
 id:string;personId:string;kind:'membership'|'pat'|'oauth';role:string|null;profile:UserAccountRow|null;
 scopes:string[]|null;overrides:ModulePermission[];createdAt:Date|string;lastUsedAt:Date|string|null;
 revokedAt:Date|string|null;accessExpiresAt:Date|string|null;refreshExpiresAt:Date|string|null;
}
const instant=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
/** Descriptive evaluation only: never creates a context or grants execution rights. */
export function reviewAccessSubject(row:AccessSubject,evaluatedAt:string,dormantDays:number){
 const now=Date.parse(evaluatedAt),cutoff=now-dormantDays*86400000,standingReasons:string[]=[],findings:string[]=[];
 if(!Number.isFinite(now)||!Number.isInteger(dormantDays)||dormantDays<1||dormantDays>3650)throw new Error('Invalid review time');
 if(row.role===null)standingReasons.push('membership_missing');
 if(!row.profile)standingReasons.push('profile_missing');else if(!isActiveUserAccount(row.profile))standingReasons.push('profile_inactive');
 const expires=instant(row.accessExpiresAt),refresh=instant(row.refreshExpiresAt),revoked=instant(row.revokedAt);
 if(row.kind!=='membership'){
  if(revoked!==null)standingReasons.push('grant_revoked');
  if(expires===null||Date.parse(expires)<=now)standingReasons.push('access_expired');
  if(!Array.isArray(row.scopes)||row.scopes.some(scope=>typeof scope!=='string'))throw new Error('Invalid stored grant scopes');
 }
 const modules=row.overrides.map(value=>value.moduleKey);
 if(new Set(modules).size!==modules.length)findings.push('duplicate_module_override');
 if(row.overrides.some(value=>value.restrictions===null||typeof value.restrictions!=='object'||Array.isArray(value.restrictions)))findings.push('malformed_module_constraints');
 const scopes=row.kind==='membership'?null:row.scopes;
 if(scopes?.some(scope=>!Object.hasOwn(EFFECTIVE_PERMISSION_RULES,scope)))findings.push('unsupported_granted_scope');
 const decisions=Object.keys(EFFECTIVE_PERMISSION_RULES).sort().map(permission=>({permission,reason:permissionReason(row.role??'',permission,scopes,row.overrides)}));
 const permissions=standingReasons.length?[]:decisions.filter(value=>value.reason===null).map(value=>value.permission);
 const denied=decisions.filter(value=>value.reason!==null).map(value=>({permission:value.permission,reason:value.reason!,conditional:value.reason==='ENTITY_REQUIRED'}));
 if(scopes?.some(scope=>decisions.some(value=>value.permission===scope&&value.reason!==null)))findings.push('granted_scope_currently_restricted');
 if(row.kind!=='membership'&&revoked===null&&standingReasons.some(reason=>['membership_missing','profile_missing','profile_inactive'].includes(reason)))findings.push('unrevoked_grant_without_active_subject');
 const createdAt=instant(row.createdAt)!,lastUsedAt=instant(row.lastUsedAt);
 const dormancy=row.kind==='membership'?'not_tracked':Date.parse(createdAt)>=cutoff?'recently_created':lastUsedAt===null?'never_observed':Date.parse(lastUsedAt)<cutoff?'dormant_observation':'recently_observed';
 return{id:row.id,personId:row.personId,kind:row.kind,role:row.role,
  authorityBasis:row.kind==='membership'?'cookie_potential':'stored_grant_current_access',permissions,denied,standingReasons,
  storedScopes:scopes===null?null:[...new Set(scopes)].sort(),findings:findings.sort(),
  refreshEligible:row.kind==='oauth'&&refresh!==null&&Date.parse(refresh)>now&&revoked===null&&standingReasons.every(reason=>reason==='access_expired'),
  createdAt,lastUsedAt,revokedAt:revoked,accessExpiresAt:expires,refreshExpiresAt:refresh,dormancy};
}
