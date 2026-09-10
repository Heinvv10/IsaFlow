import {readComparisonIntentInputs} from './auditComparisonIntentInputs';
import type {ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {readAuditSnapshotIndexHeader} from './auditSnapshotIndexRead';
import type {StoredAuditComparisonRequest} from './auditComparisonJobContract';
/** Both original retained headers must still match the authenticated ordered request on every use. */
export async function readAuditComparisonInputs(ctx:ControlTx,request:StoredAuditComparisonRequest){
 if('requestVersion'in request)await readComparisonIntentInputs(ctx,request);
 const first=await readAuditSnapshotIndexHeader(ctx,request.firstSnapshotId),second=await readAuditSnapshotIndexHeader(ctx,request.secondSnapshotId);
 const permissions=[...new Set([...first.permissions,...second.permissions])].sort();
 if((!('requestVersion'in request)&&(first.canonicalHash!==request.firstCanonicalHash||second.canonicalHash!==request.secondCanonicalHash))
  ||canonicalJson(permissions)!==canonicalJson(request.permissions))throw new Error('Comparison source identity or permissions changed');
 return{first,second};
}
