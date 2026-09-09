import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {canonicalJson} from './canonical';
import {copySnapshotArtifacts} from './auditSnapshotPublicationMaterial';
import type {AuditSnapshotData} from './auditSnapshotSeal';
export const EXPORT_LIMITS=Object.freeze({canonicalBytes:100*1024*1024,bundleBytes:1024*1024*1024,pdfBytes:600*1024*1024,pdfPages:25000,seconds:60});
export interface EvidenceExportFile {path:string;mediaType:string;bytes:Uint8Array;sha256:string;byteLength:number}
export interface ExportManifest {
 version:1;companyId:string;snapshotId:string;canonicalSnapshotHash:string;
 populations:AuditSnapshotData['populations'];checks:AuditSnapshotData['checks'];
 coverage:string[];missingSources:string[];evidence:Array<AuditSnapshotData['evidence'][number]&{path:string}>;
 files:Array<Omit<EvidenceExportFile,'bytes'>>;
}
export interface AuthenticatedExportManifest {version:1;keyId:string;canonicalData:string;canonicalHash:string;authentication:string}
export interface AuditEvidenceBundle {companyId:string;snapshotId:string;canonicalSnapshotHash:string;manifest:AuthenticatedExportManifest;files:EvidenceExportFile[]}
export function byteHash(bytes:string|Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
export function exportFile(path:string,mediaType:string,bytes:Uint8Array):EvidenceExportFile{
 return{path,mediaType,bytes,sha256:byteHash(bytes),byteLength:bytes.byteLength};
}
function authentication(keyId:string,canonicalHash:string){
 const key=process.env.CONTROL_SNAPSHOT_SIGNING_KEY;
 if(!key||key.length<32)throw new Error('Independent export signing key required');
 return createHmac('sha256',key).update(canonicalJson({domain:'isaflow:audit-evidence-export:v1',keyId,canonicalHash})).digest('hex');
}
export function sealExportManifest(value:ExportManifest):AuthenticatedExportManifest{
 const canonicalData=canonicalJson(value),canonicalHash=byteHash(canonicalData),keyId=process.env.CONTROL_SNAPSHOT_KEY_ID??'current';
 return{version:1,keyId,canonicalData,canonicalHash,authentication:authentication(keyId,canonicalHash)};
}
/** Values are JSON within quoted CSV fields: lossless, and arbitrary strings cannot become spreadsheet formulas. */
export function exportCsv(headers:readonly string[],rows:readonly (readonly unknown[])[]):Uint8Array{
 const quote=(value:string)=>`"${value.replace(/"/g,'""')}"`;
 return Buffer.from([headers.map(quote).join(','),...rows.map(row=>row.map(cell=>quote(canonicalJson(cell))).join(','))].join('\r\n')+'\r\n');
}
/** Independent bundle verifier: manifest authentication and every emitted byte, never merely adjacent hashes. */
export function verifyAuditEvidenceBundle(bundle:AuditEvidenceBundle,expected:{companyId:string;snapshotId:string}):ExportManifest{
 const identity=JSON.parse(canonicalJson(expected)) as typeof expected;
 const descriptors=Object.getOwnPropertyDescriptors(bundle);
 for(const key of ['companyId','snapshotId','canonicalSnapshotHash','manifest','files'])if(!descriptors[key]||!('value' in descriptors[key]!))throw new Error('Invalid export bundle');
 const envelope=JSON.parse(canonicalJson(descriptors.manifest!.value)) as AuthenticatedExportManifest;
 if(envelope.version!==1||envelope.keyId!==(process.env.CONTROL_SNAPSHOT_KEY_ID??'current')
  ||typeof envelope.canonicalData!=='string'||Buffer.byteLength(envelope.canonicalData)>EXPORT_LIMITS.canonicalBytes*2
  ||!/^[a-f0-9]{64}$/.test(envelope.canonicalHash)||!/^[a-f0-9]{64}$/.test(envelope.authentication)
  ||byteHash(envelope.canonicalData)!==envelope.canonicalHash
  ||!timingSafeEqual(Buffer.from(envelope.authentication,'hex'),Buffer.from(authentication(envelope.keyId,envelope.canonicalHash),'hex')))throw new Error('Export manifest authentication failed');
 const manifest=JSON.parse(envelope.canonicalData) as ExportManifest;
 if(manifest.companyId!==identity.companyId||manifest.snapshotId!==identity.snapshotId
  ||descriptors.companyId!.value!==manifest.companyId||descriptors.snapshotId!.value!==manifest.snapshotId
  ||descriptors.canonicalSnapshotHash!.value!==manifest.canonicalSnapshotHash)throw new Error('Export identity changed');
 const files:unknown=descriptors.files!.value;
 if(!Array.isArray(files)||files.length!==manifest.files.length)throw new Error('Export file population changed');
 const seen=new Set<string>();let total=0;
 for(let index=0;index<files.length;index++){
  const item=Object.getOwnPropertyDescriptor(files,String(index));
  if(!item||!('value'in item)||!item.value||typeof item.value!=='object')throw new Error('Invalid export file');
  const fields=Object.getOwnPropertyDescriptors(item.value),metadata:Record<string,unknown>={};
  for(const key of ['path','mediaType','sha256','byteLength','bytes'])if(!fields[key]||!('value'in fields[key]!))throw new Error('Invalid export file');
  for(const key of ['path','mediaType','sha256','byteLength'])metadata[key]=fields[key]!.value;
  const expectedFile=manifest.files[index]!;
  if(canonicalJson(metadata)!==canonicalJson(expectedFile)||seen.has(expectedFile.path))throw new Error('Export file metadata changed');
  // Generated PDF/CSV may exceed retained-source per-artifact bounds. Intrinsic getter avoids caller accessors.
  const raw:unknown=fields.bytes!.value;
  if(!(raw instanceof Uint8Array))throw new Error('Invalid export bytes');
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!.call(raw) as number;
  total+=length;if(total>EXPORT_LIMITS.bundleBytes||length!==expectedFile.byteLength||byteHash(raw)!==expectedFile.sha256)throw new Error('Export bytes changed or resource limit');
  seen.add(expectedFile.path);
 }
 return manifest;
}
export {copySnapshotArtifacts};

export interface ExportOptions{signal?:AbortSignal;deadlineAt?:number}
export function exportExecution(options:ExportOptions={}){
 const deadline=options.deadlineAt;
 if(deadline!==undefined&&!Number.isFinite(deadline))throw new Error('Invalid export deadline');
 const deadlineAt=Math.min(Date.now()+EXPORT_LIMITS.seconds*1000,deadline??Infinity),signal=options.signal;
 const check=()=>{signal?.throwIfAborted();if(Date.now()>=deadlineAt)throw new Error('Export runtime deadline');};
 return{deadlineAt,signal,check,async checkpoint(){check();await new Promise<void>(resolve=>setImmediate(resolve));check();}};
}
export type ExportExecution=ReturnType<typeof exportExecution>;
export async function exportByteHash(bytes:Uint8Array,execution:ExportExecution){
 const hash=createHash('sha256');
 for(let offset=0;offset<bytes.byteLength;offset+=1024*1024){
  execution.check();hash.update(bytes.subarray(offset,offset+1024*1024));await execution.checkpoint();
 }
 execution.check();return hash.digest('hex');
}
export async function copyExportArtifacts(value:readonly {id:string;bytes:Uint8Array}[],execution:ExportExecution){
 if(!Array.isArray(value)||value.length>100000)throw new Error('Invalid snapshot artifacts');
 // Capture array descriptors without invoking accessors. Each copied byte is subsequently authenticated against the sealed snapshot.
 const items=Array.from({length:value.length},(_,index)=>{
  const item=Object.getOwnPropertyDescriptor(value,String(index));if(!item||!('value'in item))throw new Error('Invalid snapshot artifact');return item.value;
 });
 const result:{id:string;bytes:Uint8Array}[]=[],ids=new Set<string>();let total=0,batchBytes=0;
 for(const item of items){
  execution.check();const copied=copySnapshotArtifacts([item])[0]!;
  total+=copied.bytes.byteLength;batchBytes+=copied.bytes.byteLength;
  if(total>100*1024*1024||ids.has(copied.id))throw new Error('Snapshot artifact resource limit or duplicate identity');
  ids.add(copied.id);result.push(copied);
  if(result.length%64===0||batchBytes>=1024*1024){await execution.checkpoint();batchBytes=0;}
 }
 execution.check();return result;
}
export async function exportCsvRows(headers:readonly string[],rows:Iterable<readonly unknown[]>,execution:ExportExecution){
 const quote=(value:string)=>`"${value.replace(/"/g,'""')}"`,parts=[headers.map(quote).join(',')];
 let count=0,size=Buffer.byteLength(parts[0]!)+2,batchBytes=0;
 for(const row of rows){
  execution.check();const line=row.map(cell=>quote(canonicalJson(cell))).join(',');
  const length=Buffer.byteLength(line)+2;size+=length;batchBytes+=length;
  if(size>EXPORT_LIMITS.bundleBytes)throw new Error('Export resource limit');parts.push(line);
  if(++count%128===0||batchBytes>=1024*1024){await execution.checkpoint();batchBytes=0;}
 }
 await execution.checkpoint();return Buffer.from(parts.join('\r\n')+'\r\n');
}
export async function sealExportManifestBounded(value:ExportManifest,execution:ExportExecution):Promise<AuthenticatedExportManifest>{
 await execution.checkpoint();const canonicalData=canonicalJson(value);
 const canonicalHash=await exportByteHash(Buffer.from(canonicalData),execution),keyId=process.env.CONTROL_SNAPSHOT_KEY_ID??'current';
 execution.check();return{version:1,keyId,canonicalData,canonicalHash,authentication:authentication(keyId,canonicalHash)};
}
