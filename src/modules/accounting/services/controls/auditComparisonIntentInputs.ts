import type {ControlTx} from './contracts';
import type {StoredAuditComparisonRequest} from './auditComparisonJobContract';
import {readAuditSnapshotIntentMetadata} from './auditSnapshotIntentMetadata';
import {canonicalJson} from './canonical';
/** Pending v2 inputs authenticate original request anchors, never unverified content hashes. */
export async function readComparisonIntentInputs(ctx:ControlTx,request:StoredAuditComparisonRequest){
 const first=await readAuditSnapshotIntentMetadata(ctx,request.firstSnapshotId),second=await readAuditSnapshotIntentMetadata(ctx,request.secondSnapshotId);
 const permissions=[...new Set([...first.permissions,...second.permissions])].sort();
 if(canonicalJson(permissions)!==canonicalJson(request.permissions))throw new Error('Comparison original intent permissions changed');
 if('requestVersion'in request){
  for(const side of ['first','second'] as const){
   const original=side==='first'?first:second,anchor=side==='first'?request.firstSource:request.secondSource;
   if(original.snapshotId!==anchor.snapshotId||original.sourceJobId!==anchor.sourceJobId||original.sourceRequestHash!==anchor.sourceRequestHash)throw new Error('Comparison original request anchor changed');
  }
 }
 return{first,second};
}
