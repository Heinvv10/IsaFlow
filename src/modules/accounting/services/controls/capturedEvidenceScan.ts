import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {CapturedEvidenceUnavailableError,loadOwnedCapturedEvidence} from './capturedEvidenceSource';
export function isCapturedEvidenceUnavailable(error:unknown):boolean{
 return error instanceof CapturedEvidenceUnavailableError;
}
/** Bounded source verification, distinct from complete SQL population discovery. */
export async function scanCapturedEvidence(ctx:ControlTx,documentIds:readonly (string|null)[],permission:'read:invoices'|'read:bank-tx'){
 assertControlTx(ctx);await assertEffectivePermission(ctx,permission);
 const ids=[...new Set(documentIds.filter((id):id is string=>id!==null))].sort();
 const verified=new Map<string,string>(),missing=new Set<string>();
 if(ids.length>100)return{verified,evidenceMissing:['async_scan_required:captured_evidence_population_exceeds_100']};
 const deadline=AbortSignal.timeout(ctx.principal.authMethod==='job'?20000:900);let total=0;
 for(const id of ids){
  if(deadline.aborted){verified.clear();missing.add('async_scan_required:captured_evidence_deadline');break;}
  try{
   const evidence=await loadOwnedCapturedEvidence(ctx,id,permission,deadline);
   if(evidence){
    total+=evidence.bytes.byteLength;
    if(total>100*1024*1024){verified.clear();missing.add('async_scan_required:captured_evidence_byte_limit');break;}
   }
   if(evidence?.recordedHashVerified)verified.set(id,evidence.sha256);
   else missing.add('captured_source_bytes_unavailable_or_unverified');
  }catch(error){
   if(!isCapturedEvidenceUnavailable(error))throw error;
   if(deadline.aborted){verified.clear();missing.add('async_scan_required:captured_evidence_deadline');break;}
   // Only failures from the storage boundary describe unavailable source bytes.
   missing.add('captured_source_bytes_unavailable_or_changed');
  }
 }
 return{verified,evidenceMissing:[...missing].sort()};
}
