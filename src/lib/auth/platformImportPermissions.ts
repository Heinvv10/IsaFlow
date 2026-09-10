import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {readPlatformImportTarget,assertCurrentPlatformImportStanding} from './platformImportAuthority';
import {EFFECTIVE_PERMISSION_RULES,type PermissionReason} from './effectivePermissionPolicy';
import {EffectivePermissionError} from './effectivePermissionQueries';
/** This ceiling does not authorize a resource: historical source/operation boundaries must also match the private target. */
export async function platformImportPermissions(ctx:ControlTx){
 const target=readPlatformImportTarget(ctx);await assertCurrentPlatformImportStanding(ctx);
 // Exactly what the confined path asks for. A generic tenant reader running on the
 // BYPASSRLS platform client is outside confinement, so it must find no permission here.
 const permissions=target.action==='retain'?[]:['read:imports'];
 if(target.action!=='read')permissions.push('write:imports');
 if(target.action==='request')permissions.push('write:approvals');
 if(target.action==='execute')permissions.push('write:post');
 const denied:Record<string,PermissionReason>={};
 for(const permission of Object.keys(EFFECTIVE_PERMISSION_RULES))if(!permissions.includes(permission))denied[permission]='ROLE_CEILING';
 return{companyId:ctx.principal.companyId,personId:ctx.principal.personId,role:'platform_import',permissions,denied};
}
export async function assertPlatformImportPermission(ctx:ControlTx,permission:string){
 const resolved=await platformImportPermissions(ctx);
 if(!resolved.permissions.includes(permission))throw new EffectivePermissionError();
}
