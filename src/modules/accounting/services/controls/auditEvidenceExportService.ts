import type {ControlTx} from './contracts';
import {readRetainedAuditSnapshot} from './auditSnapshotPublication';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {assertSnapshotArtifacts,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {canonicalJson} from './canonical';
import {renderEvidencePdf} from './auditEvidenceExportPdf';
import {copySnapshotArtifacts,exportCsv,exportFile,sealExportManifest,EXPORT_LIMITS,type AuditEvidenceBundle,type ExportManifest,type EvidenceExportFile} from './auditEvidenceExportMaterial';
/** Background service only: current retained-reader permissions, no mutable business-row reload. */
export async function exportAuditEvidence(ctx:ControlTx,snapshotId:string):Promise<AuditEvidenceBundle>{
 if(typeof snapshotId!=='string')throw new Error('Invalid snapshot identity');
 const retained=await readRetainedAuditSnapshot(ctx,snapshotId);
 return renderAuditEvidence(retained.sealed,retained.artifacts,{companyId:ctx.principal.companyId,snapshotId});
}
/** Pure renderer still authenticates tenant-bound input and every source byte; it grants no read authority. */
export async function renderAuditEvidence(sealed:SealedAuditSnapshot,sourceArtifacts:readonly SnapshotArtifactBytes[],expected:{companyId:string;snapshotId:string}):Promise<AuditEvidenceBundle>{
 const deadline=Date.now()+EXPORT_LIMITS.seconds*1000;
 const safeSeal=JSON.parse(canonicalJson(sealed)) as SealedAuditSnapshot;
 const snapshot=verifyAuditSnapshot(safeSeal,expected),artifacts=copySnapshotArtifacts(sourceArtifacts);
 assertSnapshotArtifacts(snapshot,artifacts);
 const files:EvidenceExportFile[]=[];let emitted=0;
 function add(path:string,mediaType:string,bytes:Uint8Array){
  emitted+=bytes.byteLength;
  if(emitted>EXPORT_LIMITS.bundleBytes||Date.now()>deadline)throw new Error('Export resource or runtime limit');
  files.push(exportFile(path,mediaType,bytes));
 }
 const {canonicalData,...sealMetadata}=safeSeal;
 add('snapshot.json','application/json',Buffer.from(canonicalData));
 add('snapshot-seal.json','application/json',Buffer.from(canonicalJson(sealMetadata)));
 add('records.csv','text/csv',exportCsv(['source','id','version','data'],snapshot.records.map(row=>[row.source,row.id,row.version,row.data])));
 add('checks.csv','text/csv',exportCsv(['checkId','checkVersion','status','completeResult'],snapshot.checks.map(check=>[check.checkId,check.checkVersion,check.status,check])));
 add('evidence.pdf','application/pdf',await renderEvidencePdf(snapshot,safeSeal.canonicalHash,deadline));
 const byId=new Map(artifacts.map(artifact=>[artifact.id,artifact.bytes]));
 const evidence=snapshot.evidence.map((item,index)=>{
  const path=`evidence/${String(index+1).padStart(6,'0')}.bin`;
  add(path,item.mediaType,byId.get(item.id)!);return{...item,path};
 });
 const manifest:ExportManifest={version:1,companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalSnapshotHash:safeSeal.canonicalHash,
  populations:snapshot.populations,checks:snapshot.checks,coverage:snapshot.coverage,missingSources:snapshot.missingSources,evidence,
  files:files.map(({bytes:_bytes,...metadata})=>metadata)};
 const signed=sealExportManifest(manifest);
 const total=files.reduce((sum,file)=>sum+file.byteLength,Buffer.byteLength(canonicalJson(signed)));
 if(total>EXPORT_LIMITS.bundleBytes||Date.now()>deadline)throw new Error('Export resource or runtime limit');
 return{companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalSnapshotHash:safeSeal.canonicalHash,manifest:signed,files};
}
