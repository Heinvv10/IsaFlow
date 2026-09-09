import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {z} from 'zod';
import {canonicalJson} from './canonical';
import {verifyAuditSnapshot} from './auditSnapshotSeal';
import {deriveIndexPermissions,detachIndexValue} from './auditSnapshotIndexValidation';
import type {AuditEvidenceBundle,AuthenticatedExportManifest,ExportManifest,EvidenceExportFile} from './auditEvidenceExportMaterial';
import {EXPORT_DELIVERY_LIMITS as limits} from './auditExportDeliveryContract';
const hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative();
export const deliveryIdentity=z.object({companyId:z.string().uuid(),snapshotId:z.string().uuid(),jobId:z.string().uuid(),leaseId:z.string().uuid(),
 generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),canonicalSnapshotHash:hash}).strict();
export const deliveryHeader=deliveryIdentity.extend({version:z.literal(1),fileCount:count.min(6).max(limits.maxFiles),
 totalBytes:count.max(limits.bundleBytes),permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)})
 .refine(v=>v.permissions.includes('read:reports')&&canonicalJson(v.permissions)===canonicalJson([...new Set(v.permissions)].sort()),'Invalid delivery permissions');
const metadata=z.object({path:z.string().regex(/^(snapshot\.json|snapshot-seal\.json|records\.csv|checks\.csv|evidence\.pdf|manifest\.json|evidence\/[0-9]{6}\.bin)$/),
 mediaType:z.string().min(1).max(256),byteLength:count.max(limits.bundleBytes),sha256:hash}).strict();
export const deliveryFile=deliveryIdentity.extend({...metadata.shape,ordinal:count.max(limits.maxFiles-1),chunkCount:count.max(limits.bundleBytes/limits.chunkBytes)})
 .refine(v=>v.chunkCount===Math.ceil(v.byteLength/limits.chunkBytes),'Invalid delivery chunk count');
export const deliveryChunk=z.object({file:deliveryFile,chunkOrdinal:count,sha256:hash,bytesBase64:z.string().max(349528)}).strict();
const typed=Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!;
const byteOffset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!;
const arrayBuffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!;
/** Byte-size admission shared by manifest and aggregate delivery accounting. */
export function assertDeliverySize(bytes:number):void{
 if(!Number.isSafeInteger(bytes)||bytes<0||bytes>limits.bundleBytes)throw new Error('Export delivery resource limit');
}
function fields(value:unknown,names:string[]){
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))
  ||Reflect.ownKeys(value).length!==names.length)throw new Error('Invalid export delivery fields');
 const result:Record<string,unknown>={};
 for(const name of names){const d=Object.getOwnPropertyDescriptor(value,name);if(!d?.enumerable||!('value'in d))throw new Error('Invalid export delivery field');result[name]=d.value;}
 return result;
}
export async function deliveryHash(bytes:Uint8Array,check:()=>void){
 const h=createHash('sha256');
 for(let i=0;i<bytes.length;i+=1048576){check();h.update(bytes.subarray(i,i+1048576));await setImmediate();check();}
 return h.digest('hex');
}
/** Verify every private byte before header publication. No untrusted byte-length accessors or iterator calls. */
export async function prepareDelivery(bundle:AuditEvidenceBundle,identity:z.infer<typeof deliveryIdentity>,provided:string[],check:()=>void){
 const values=fields(bundle,['companyId','snapshotId','canonicalSnapshotHash','manifest','files']);
 if(values.companyId!==identity.companyId||values.snapshotId!==identity.snapshotId||values.canonicalSnapshotHash!==identity.canonicalSnapshotHash)throw new Error('Export delivery identity changed');
 const raw=fields(values.manifest,['version','keyId','canonicalData','canonicalHash','authentication']);
 if(raw.version!==1||typeof raw.keyId!=='string'||raw.keyId!==(process.env.CONTROL_SNAPSHOT_KEY_ID??'current')
  ||typeof raw.canonicalData!=='string'
  ||!hash.safeParse(raw.canonicalHash).success||!hash.safeParse(raw.authentication).success)throw new Error('Invalid export manifest');
 assertDeliverySize(Buffer.byteLength(raw.canonicalData));
 const envelope=raw as unknown as AuthenticatedExportManifest,encodedManifest=canonicalJson(envelope);
 assertDeliverySize(Buffer.byteLength(encodedManifest));
 const manifestBytes=Buffer.from(encodedManifest);
 const files=values.files;
 if(!Array.isArray(files)||Object.getPrototypeOf(files)!==Array.prototype||files.length+1>limits.maxFiles
  ||Reflect.ownKeys(files).length!==files.length+1)throw new Error('Export file population limit');
 let total=manifestBytes.length;
 const pending:Array<{metadata:z.infer<typeof metadata>;source:Uint8Array}>=[];
 for(let i=0;i<files.length;i++){
  const d=Object.getOwnPropertyDescriptor(files,String(i));if(!d||!('value'in d))throw new Error('Invalid export file');
  const f=fields(d.value,['path','mediaType','byteLength','sha256','bytes']),{bytes,...rest}=f;
  const parsed=metadata.parse(detachIndexValue(rest));
  if(!(bytes instanceof Uint8Array)||byteLength.call(bytes)!==parsed.byteLength)throw new Error('Export file length changed');
  total+=parsed.byteLength;assertDeliverySize(total);
  pending.push({metadata:parsed,source:new Uint8Array(arrayBuffer.call(bytes),byteOffset.call(bytes),parsed.byteLength)});
 }
 check();await setImmediate();check();
 const key=process.env.CONTROL_SNAPSHOT_SIGNING_KEY;
 if(!key||key.length<32)throw new Error('Independent export signing key required');
 const canonicalHash=await deliveryHash(Buffer.from(envelope.canonicalData),check);
 const authentication=createHmac('sha256',key).update(canonicalJson({domain:'isaflow:audit-evidence-export:v1',keyId:envelope.keyId,canonicalHash})).digest();
 if(canonicalHash!==envelope.canonicalHash||!timingSafeEqual(authentication,Buffer.from(envelope.authentication,'hex')))throw new Error('Export manifest authentication failed');
 const manifest=JSON.parse(envelope.canonicalData) as ExportManifest;
 if(manifest.companyId!==identity.companyId||manifest.snapshotId!==identity.snapshotId||manifest.canonicalSnapshotHash!==identity.canonicalSnapshotHash
  ||!Array.isArray(manifest.files)||manifest.files.length!==pending.length)throw new Error('Export manifest identity or population changed');
 const copied:EvidenceExportFile[]=[],seen=new Set<string>();
 for(let i=0;i<pending.length;i++){
  const p=pending[i]!;
  if(p.metadata.path==='manifest.json'||seen.has(p.metadata.path)||canonicalJson(p.metadata)!==canonicalJson(manifest.files[i]))throw new Error('Export file metadata changed');
  seen.add(p.metadata.path);const bytes=new Uint8Array(p.metadata.byteLength);
  for(let offset=0;offset<bytes.length;offset+=1048576){check();bytes.set(p.source.subarray(offset,offset+1048576),offset);await setImmediate();check();}
  if(await deliveryHash(bytes,check)!==p.metadata.sha256)throw new Error('Export file bytes changed');
  copied.push({...p.metadata,bytes});
 }
 const byPath=new Map(copied.map(f=>[f.path,f]));
 for(const path of ['snapshot.json','snapshot-seal.json','records.csv','checks.csv','evidence.pdf'])if(!byPath.has(path))throw new Error('Export generated file missing');
 const canonicalData=Buffer.from(byPath.get('snapshot.json')!.bytes).toString('utf8');
 if(Buffer.byteLength(canonicalData)>100*1024*1024)throw new Error('Export snapshot resource limit');
 const seal=JSON.parse(Buffer.from(byPath.get('snapshot-seal.json')!.bytes).toString('utf8')) as Record<string,unknown>;
 if('canonicalData'in seal)throw new Error('Export seal metadata changed');
 const snapshot=verifyAuditSnapshot({...seal,canonicalData} as Parameters<typeof verifyAuditSnapshot>[0],{companyId:identity.companyId,snapshotId:identity.snapshotId});
 if(seal.canonicalHash!==identity.canonicalSnapshotHash)throw new Error('Export canonical snapshot changed');
 for(const key of ['populations','checks','coverage','missingSources'] as const)if(canonicalJson(manifest[key])!==canonicalJson(snapshot[key]))throw new Error('Export manifest source population changed');
 if(!Array.isArray(manifest.evidence)||manifest.evidence.length!==snapshot.evidence.length||copied.length!==snapshot.evidence.length+5)throw new Error('Export evidence population changed');
 for(let i=0;i<snapshot.evidence.length;i++){
  const evidence=snapshot.evidence[i]!,path=`evidence/${String(i+1).padStart(6,'0')}.bin`,file=byPath.get(path);
  if(canonicalJson(manifest.evidence[i])!==canonicalJson({...evidence,path})||!file||file.sha256!==evidence.sha256
   ||file.byteLength!==evidence.byteLength||file.mediaType!==evidence.mediaType)throw new Error('Export evidence changed');
 }
 const permissions=deriveIndexPermissions(snapshot,provided);
 copied.push({path:'manifest.json',mediaType:'application/json',bytes:manifestBytes,byteLength:manifestBytes.length,sha256:await deliveryHash(manifestBytes,check)});
 check();return{files:copied,totalBytes:total,permissions};
}
