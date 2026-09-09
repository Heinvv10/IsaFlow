import type {ControlTx} from './contracts';
import {readRetainedAuditSnapshot} from './auditSnapshotPublication';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {canonicalJson} from './canonical';
import {renderEvidencePdf} from './auditEvidenceExportPdf';
import {copyExportArtifacts,exportCsvRows,exportByteHash,exportExecution,sealExportManifestBounded,EXPORT_LIMITS,type ExportOptions,type AuditEvidenceBundle,type ExportManifest,type EvidenceExportFile} from './auditEvidenceExportMaterial';
/** Background service only: current retained-reader permissions, no mutable business-row reload. */
export async function exportAuditEvidence(ctx:ControlTx,snapshotId:string,options:ExportOptions={}):Promise<AuditEvidenceBundle>{
 const execution=exportExecution(options);execution.check();
 if(typeof snapshotId!=='string')throw new Error('Invalid snapshot identity');
 const retained=await readRetainedAuditSnapshot(ctx,snapshotId);execution.check();
 return renderAuditEvidence(retained.sealed,retained.artifacts,{companyId:ctx.principal.companyId,snapshotId},execution);
}
/** Pure renderer still authenticates tenant-bound input and every source byte; it grants no read authority. */
export async function renderAuditEvidence(sealed:SealedAuditSnapshot,sourceArtifacts:readonly SnapshotArtifactBytes[],expected:{companyId:string;snapshotId:string},options:ExportOptions={}):Promise<AuditEvidenceBundle>{
 const execution=exportExecution(options);execution.check();
 const safeSeal=JSON.parse(canonicalJson(sealed)) as SealedAuditSnapshot;
 const snapshot=verifyAuditSnapshot(safeSeal,expected);execution.check();
 const artifacts=await copyExportArtifacts(sourceArtifacts,execution);
 if(snapshot.evidence.length!==artifacts.length)throw new Error('Snapshot artifact population is incomplete');
 const metadata=new Map(snapshot.evidence.map(item=>[item.id,item]));
 for(const artifact of artifacts){
  const item=metadata.get(artifact.id);
  if(!item||item.byteLength!==artifact.bytes.byteLength||item.sha256!==await exportByteHash(artifact.bytes,execution))throw new Error('Retained snapshot artifact changed or missing');
 }
 const files:EvidenceExportFile[]=[];let emitted=0;
 async function add(path:string,mediaType:string,bytes:Uint8Array){
  emitted+=bytes.byteLength;
  if(emitted>EXPORT_LIMITS.bundleBytes)throw new Error('Export resource or runtime limit');
  files.push({path,mediaType,bytes,byteLength:bytes.byteLength,sha256:await exportByteHash(bytes,execution)});
 }
 const {canonicalData,...sealMetadata}=safeSeal;
 await add('snapshot.json','application/json',Buffer.from(canonicalData));
 await add('snapshot-seal.json','application/json',Buffer.from(canonicalJson(sealMetadata)));
 await add('records.csv','text/csv',await exportCsvRows(['source','id','version','data'],(function*(){for(const row of snapshot.records)yield[row.source,row.id,row.version,row.data];})(),execution));
 await add('checks.csv','text/csv',await exportCsvRows(['checkId','checkVersion','status','completeResult'],(function*(){for(const check of snapshot.checks)yield[check.checkId,check.checkVersion,check.status,check];})(),execution));
 await add('evidence.pdf','application/pdf',await renderEvidencePdf(snapshot,safeSeal.canonicalHash,execution.deadlineAt,execution));
 const byId=new Map(artifacts.map(artifact=>[artifact.id,artifact.bytes]));
 const evidence:ExportManifest['evidence']=[];
 for(const [index,item] of snapshot.evidence.entries()){
  const path=`evidence/${String(index+1).padStart(6,'0')}.bin`;
  await add(path,item.mediaType,byId.get(item.id)!);evidence.push({...item,path});
  if(index%64===0)await execution.checkpoint();
 }
 const manifest:ExportManifest={version:1,companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalSnapshotHash:safeSeal.canonicalHash,
  populations:snapshot.populations,checks:snapshot.checks,coverage:snapshot.coverage,missingSources:snapshot.missingSources,evidence,
  files:files.map(({bytes:_bytes,...metadata})=>metadata)};
 const signed=await sealExportManifestBounded(manifest,execution);
 const total=files.reduce((sum,file)=>sum+file.byteLength,Buffer.byteLength(canonicalJson(signed)));
 if(total>EXPORT_LIMITS.bundleBytes)throw new Error('Export resource or runtime limit');
 execution.check();return{companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalSnapshotHash:safeSeal.canonicalHash,manifest:signed,files};
}
