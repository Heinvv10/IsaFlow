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
