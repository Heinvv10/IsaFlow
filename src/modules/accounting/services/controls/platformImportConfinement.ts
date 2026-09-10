import {createHash} from 'node:crypto';
import {readPlatformImportTarget} from '@/lib/auth/platformImportAuthority';
import {assertControlTx} from './context';
import type {ControlTx,OperationRef} from './contracts';
function target(ctx:ControlTx){
 assertControlTx(ctx);const value=readPlatformImportTarget(ctx);
 if(value.companyId!==ctx.principal.companyId)throw new Error('Platform import target company differs');
 return value;
}
async function intent(ctx:ControlTx,id:string){
 const rows=await ctx.sql`SELECT source_id,requester_person_id,requester_auth_method FROM control_historical_imports
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as {source_id:string;requester_person_id:string;requester_auth_method:string}[];
 if(rows.length!==1||rows[0]!.requester_person_id!==ctx.principal.personId||rows[0]!.requester_auth_method!=='platform_import')throw new Error('Platform import target association unavailable');
 return rows[0]!;
}
/** Independent of permission ceilings: no selected import capability may enter another operation kernel. */
export async function assertPlatformImportOperation(ctx:ControlTx,ref:OperationRef,stage:'materialize'|'request'|'execute'){
 if(ctx.principal.authMethod!=='platform_import')return;
 const selected=target(ctx);
 if(ref.entityType!=='historical_import'||ref.operation!=='historical_import.post')throw new Error('Platform authority is restricted to historical imports');
 if(stage!=='materialize'&&selected.action!==stage)throw new Error('Platform import action differs');
 if(selected.action==='retain')throw new Error('Source retention cannot operate on an import');
 if(selected.action==='prepare'){
  if(stage!=='materialize'||(await intent(ctx,ref.entityId)).source_id!==selected.sourceId)throw new Error('Prepared import differs from selected source');
 }else if(selected.importId!==ref.entityId.toLowerCase())throw new Error('Platform import identity differs');
}
export async function assertPlatformImportSourceRead(ctx:ControlTx,sourceId:string){
 if(ctx.principal.authMethod!=='platform_import')return;
 const selected=target(ctx);
 if(selected.action==='retain')throw new Error('Source retention does not authorize source reads');
 const expected=selected.action==='prepare'?selected.sourceId:(await intent(ctx,selected.importId)).source_id;
 if(sourceId.toLowerCase()!==expected)throw new Error('Platform import source identity differs');
}
export function assertPlatformImportSourceWrite(ctx:ControlTx,bytes:Buffer){
 if(ctx.principal.authMethod!=='platform_import')return;
 const selected=target(ctx);
 if(selected.action!=='retain'||createHash('sha256').update(bytes).digest('hex')!==selected.sourceHash)throw new Error('Platform retained source bytes differ');
}
export function assertPlatformImportPreparation(ctx:ControlTx,sourceId:string){
 if(ctx.principal.authMethod!=='platform_import')return;
 const selected=target(ctx);
 if(selected.action!=='prepare'||selected.sourceId!==sourceId.toLowerCase())throw new Error('Platform source preparation target differs');
}
