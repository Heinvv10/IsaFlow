import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {parseAuditSnapshotRequest,type AuditSnapshotRequest} from './auditJobContract';
import type {AuditSnapshotData} from './auditSnapshotSeal';
import {assertSnapshotRequest,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {discoverSnapshotEvidence,type SnapshotEvidenceRelation} from './auditSnapshotEvidenceQueries';
import {loadOwnedCapturedEvidence} from './capturedEvidenceSource';
import {loadOwnedProcurementEvidence} from './procurementEvidenceSource';
import {loadOwnedBankAttachmentEvidence} from './bankAttachmentEvidenceSource';
type RetainedRelation={parentSource:string;parentId:string;relation:string};
function permission(source:string){
 if(source.startsWith('bank_'))return 'read:bank-tx' as const;
 if(source.startsWith('payroll_'))return 'read:payroll' as const;
 if(source.startsWith('journal_'))return 'read:reports' as const;
 return 'read:invoices' as const;
}
async function read(ctx:ControlTx,relation:SnapshotEvidenceRelation,signal:AbortSignal){
 if(relation.store==='bank_attachment'){
  const value=await loadOwnedBankAttachmentEvidence(ctx,relation.documentId,signal);
  return value?.status==='available'?value:null;
 }
 if(relation.store==='procurement')return loadOwnedProcurementEvidence(ctx,relation.documentId,signal);
 return loadOwnedCapturedEvidence(ctx,relation.documentId,permission(relation.parentSource),signal);
}
/** Capture and this coordinator share one repeatable-read transaction; no partial material is published here. */
export async function retainSnapshotEvidence(ctx:ControlTx,input:AuditSnapshotData,requestInput:AuditSnapshotRequest,signal?:AbortSignal){
 assertControlTx(ctx);
 const encoded=canonicalJson(input);if(Buffer.byteLength(encoded)>100*1024*1024)throw new Error('Snapshot resource limit');
 const snapshot=JSON.parse(encoded) as AuditSnapshotData;
 const request=parseAuditSnapshotRequest(JSON.parse(canonicalJson(requestInput)));
 assertSnapshotRequest(snapshot,request);
 if(snapshot.evidence.length||snapshot.evidenceGaps?.length)throw new Error('Snapshot evidence already attached');
 const deadline=AbortSignal.any([AbortSignal.timeout(60000),...signal?[signal]:[]]),started=Date.now();
 const [state]=await ctx.sql`SELECT current_setting('statement_timeout') AS timeout,
  EXTRACT(EPOCH FROM current_setting('statement_timeout')::interval)*1000 AS timeout_ms,current_setting('transaction_isolation') AS isolation` as {timeout:string;timeout_ms:string;isolation:string}[];
 if(state?.isolation!=='repeatable read')throw new Error('Evidence retention requires repeatable read');
 const budget=async()=>{
  deadline.throwIfAborted();
  const remaining=Math.max(1,60000-(Date.now()-started));
  await ctx.sql`SELECT set_config('statement_timeout',${`${Math.min(remaining,Number(state.timeout_ms)||remaining)}ms`},true)`;
 };
 const groups=new Map<string,{source:SnapshotEvidenceRelation;relations:RetainedRelation[]}>(),keys=new Set<string>(),cursors=new Set<string>();
 let cursor:string|undefined,expected:number|undefined;
 do{
  await budget();const page=await discoverSnapshotEvidence(ctx,snapshot,{limit:1000,...cursor?{cursor}:{}});
  if(expected!==undefined&&expected!==page.relationCount)throw new Error('Evidence population changed');expected=page.relationCount;
  for(const relation of page.relations){
   const key=canonicalJson(relation);if(keys.has(key))throw new Error('Duplicate evidence relation');keys.add(key);
   if(keys.size>100000)throw new Error('Evidence population resource limit');
   const id=`${relation.store}:${relation.documentId}`,parent={parentSource:relation.parentSource,parentId:relation.parentId,relation:relation.relation};
   const group=groups.get(id);if(group)group.relations.push(parent);else groups.set(id,{source:relation,relations:[parent]});
  }
  cursor=page.nextCursor??undefined;
  if(cursor){if(cursors.has(cursor)||!page.relations.length)throw new Error('Evidence cursor did not advance');cursors.add(cursor);}
 }while(cursor);
 if(keys.size!==expected)throw new Error('Incomplete evidence population');
 const artifacts:SnapshotArtifactBytes[]=[],missing=new Set(snapshot.missingSources.filter(value=>value!=='retained_evidence_not_attached'));
 snapshot.evidenceGaps=[];let total=0;
 for(const [id,group] of groups){
  await budget();const value=await read(ctx,group.source,deadline);deadline.throwIfAborted();
  if(!value){
   snapshot.evidenceGaps.push({id,reason:'source_bytes_unavailable',relations:group.relations});
   missing.add('retained_source_bytes_unavailable');continue;
  }
  total+=value.bytes.byteLength;if(total>100*1024*1024)throw new Error('Snapshot artifact resource limit');
  artifacts.push({id,bytes:new Uint8Array(value.bytes)});
  snapshot.evidence.push({id,sha256:value.sha256,byteLength:value.bytes.byteLength,mediaType:value.mediaType,relations:group.relations});
  if(!value.recordedHashVerified)missing.add(`${group.source.store}:historical_source_hash_unavailable`);
 }
 snapshot.missingSources=[...missing].sort();
 snapshot.coverage=[...new Set([...snapshot.coverage,'all_discovered_owned_evidence_retained_or_explicitly_missing'])].sort();
 if(Buffer.byteLength(canonicalJson(snapshot))>100*1024*1024)throw new Error('Snapshot resource limit');
 deadline.throwIfAborted();await ctx.sql`SELECT set_config('statement_timeout',${state.timeout},true)`;
 return{snapshot,artifacts};
}
