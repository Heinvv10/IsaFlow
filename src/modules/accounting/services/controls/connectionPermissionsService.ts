import type {ControlTx} from './contracts';
import {resolveEffectivePermissions} from '@/lib/auth/effectivePermissions';
/** Self-inspection authenticates current authority; it grants no additional rights. */
export async function getConnectionPermissions(ctx:ControlTx){
 const current=await resolveEffectivePermissions(ctx);
 const {companyId,personId,authMethod,connectionId,grantId,actingFirmId}=ctx.principal;
 return{companyId,personId,authMethod,connectionId,grantId,actingFirmId,role:current.role,
  permissions:[...current.permissions].sort(),
  denied:Object.keys(current.denied).sort().map(permission=>({permission,reason:current.denied[permission]!,conditional:current.denied[permission]==='ENTITY_REQUIRED'}))};
}
