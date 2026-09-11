import {assertPlatformImportOperation} from './platformImportConfinement';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {canonicalOperationRef} from './operationMaterializer';
import {operationPermission,operationRequiresPosting} from './operationPermissions';
import {executeControlledOperation} from './approvalExecutionService';
import type {ControlTx,OperationRef} from './contracts';
/** Replay proves present authority; knowledge of an old effect ID does not grant execution or read access. */
export async function replayKnownOperationEffect<T>(ctx:ControlTx,input:OperationRef,effectId:string):Promise<T>{
 assertControlTx(ctx);const ref=canonicalOperationRef(input);
 await assertPlatformImportOperation(ctx,ref,'execute');
 await assertEffectivePermission(ctx,operationPermission(ref.operation,'write'));
 if(operationRequiresPosting(ref.operation))await assertEffectivePermission(ctx,'write:post');
 if(!UUID_RE.test(effectId))throw new Error('Invalid operation effect association');
 // One request can request approval for one entity and effect another; only an approval that consumed
 // this effect, or was bound to the same operation and entity, belongs to it. The second arm catches an
 // erased consumed link, which holds only because migration 627 grants app_user UPDATE on status,
 // decided_at, consumed_at and consumed_effect_id alone — never entity_id or operation_id.
 const rows=await ctx.sql`SELECT e.id,e.result,a.id AS approval_id,a.status AS approval_status,a.consumed_effect_id
  FROM control_operation_effects e LEFT JOIN control_operation_approvals a ON a.company_id=e.company_id
   AND (a.consumed_effect_id=e.id OR (a.operation_id=e.operation_id AND a.operation=e.operation
    AND a.entity_type=e.entity_type AND a.entity_id_canonical=e.entity_id_canonical))
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.id=${effectId}::uuid
   AND e.operation=${ref.operation} AND e.entity_type=${ref.entityType} AND e.entity_id_canonical=${ref.entityId} LIMIT 2` as
  {id:string;result:T;approval_id:string|null;approval_status:string|null;consumed_effect_id:string|null}[];
 if(rows.length!==1)throw new Error('Operation effect association is missing or ambiguous');
 const effect=rows[0]!;
 if(!effect.approval_id)return effect.result;
 if(effect.approval_status!=='consumed'||effect.consumed_effect_id!==effect.id)throw new Error('Approval effect linkage is invalid');
 // The kernel locks and rechecks the original requester grant, decisions and
 // current approver authority before its committed-effect branch returns.
 return executeControlledOperation<T>(ctx,ref,effect.approval_id,async()=>{throw new Error('Receipt replay cannot create a new effect');});
}
