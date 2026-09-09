import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from './canonical';
import {AUDIT_JOB_LIMITS} from './auditJobContract';

const text=z.string().min(1).max(256);
const count=z.number().int().nonnegative().max(AUDIT_JOB_LIMITS.maxRecords);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
 const parsed=new Date(`${value}T00:00:00.000Z`);
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
});
const bodySchema=z.object({
 version:z.literal(1),companyId:z.string().uuid(),snapshotId:z.string().uuid(),cutoff:date,
 capturedAt:z.string().datetime(),
 records:z.array(z.object({source:text,id:text,version:z.number().int().positive().nullable(),
  data:z.record(z.string(),z.unknown())}).strict()).max(AUDIT_JOB_LIMITS.maxRecords),
 populations:z.array(z.object({source:text,count,excludedCount:count,exclusions:z.array(text).max(1000)}).strict()).max(100),
 checks:z.array(z.object({checkId:text,checkVersion:z.number().int().positive(),
  status:z.enum(['pass','fail','unknown','error']),populationCount:count,excludedCount:count,findingCount:count,
  amountTotals:z.record(z.string(),z.string()),findings:z.array(z.record(z.string(),z.unknown())).max(AUDIT_JOB_LIMITS.maxRecords),
  nextCursor:z.null(),coverage:z.array(text),missingSources:z.array(text),capturedAt:z.string().datetime(),cutoff:date,
  sourceVersions:z.array(z.object({entityType:text,entityId:text,version:z.number().int().nonnegative(),fingerprint:hash}).strict()),
 }).strict()).max(6),
 evidence:z.array(z.object({id:text,sha256:hash,byteLength:z.number().int().nonnegative().max(100*1024*1024),mediaType:text,
  relations:z.array(z.object({parentSource:text,parentId:text,relation:text}).strict()).max(AUDIT_JOB_LIMITS.maxRecords).optional(),
 }).strict()).max(AUDIT_JOB_LIMITS.maxRecords),
 coverage:z.array(text).max(1000),missingSources:z.array(text).max(1000),
}).strict();
export type AuditSnapshotData=z.infer<typeof bodySchema>;
export interface SealedAuditSnapshot {version:1;keyId:string;canonicalData:string;canonicalHash:string;authentication:string}
const MAX_CANONICAL_BYTES=100*1024*1024;
const envelopeSchema=z.object({version:z.literal(1),keyId:text,canonicalData:z.string().max(MAX_CANONICAL_BYTES),
 canonicalHash:hash,authentication:hash}).strict();
const identitySchema=z.object({companyId:z.string().uuid(),snapshotId:z.string().uuid()}).strict();
const verifiedSnapshots=new WeakSet<AuditSnapshotData>();
function freezeRetained(value:unknown):void{
 if(value!==null&&typeof value==='object'){
  for(const child of Object.values(value))freezeRetained(child);
  Object.freeze(value);
 }
}
function sha(bytes:string|Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
function sortedUnique<T>(items:T[],identity:(item:T)=>string):T[]{
 const seen=new Set<string>();
 for(const item of items){const id=identity(item);if(seen.has(id))throw new Error('Duplicate snapshot identity');seen.add(id);}
 return [...items].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
}
function normalize(input:unknown):AuditSnapshotData{
 // Validate descriptors before any schema parser can invoke accessors or discard hidden data.
 const encoded=canonicalJson(input);if(Buffer.byteLength(encoded)>MAX_CANONICAL_BYTES)throw new Error('Snapshot resource limit');
 const body=bodySchema.parse(JSON.parse(encoded));
 body.records=sortedUnique(body.records,row=>canonicalJson([row.source,row.id]));
 body.populations=sortedUnique(body.populations,row=>row.source);
 body.evidence=sortedUnique(body.evidence,row=>row.id);
 const parents=new Set(body.records.map(row=>canonicalJson([row.source,row.id])));let relationCount=0;
 for(const evidence of body.evidence){
  if(evidence.relations===undefined)continue; // Old sealed snapshots retain their original canonical bytes.
  relationCount+=evidence.relations.length;
  if(relationCount>AUDIT_JOB_LIMITS.maxRecords)throw new Error('Snapshot evidence relation limit');
  evidence.relations=sortedUnique(evidence.relations,row=>canonicalJson([row.parentSource,row.parentId,row.relation]));
  for(const relation of evidence.relations){
   if(!parents.has(canonicalJson([relation.parentSource,relation.parentId])))throw new Error('Snapshot evidence parent missing');
  }
 }
 body.checks=sortedUnique(body.checks,row=>row.checkId);
 body.coverage=sortedUnique(body.coverage,value=>value);body.missingSources=sortedUnique(body.missingSources,value=>value);
 const counts=new Map<string,number>();for(const row of body.records)counts.set(row.source,(counts.get(row.source)??0)+1);
 for(const population of body.populations){
  if((counts.get(population.source)??0)!==population.count)throw new Error('Incomplete snapshot population');
  if(population.excludedCount>0&&!population.exclusions.length)throw new Error('Snapshot exclusions require coverage');
  population.exclusions=sortedUnique(population.exclusions,value=>value);counts.delete(population.source);
 }
 if(counts.size)throw new Error('Undeclared snapshot population');
 for(const check of body.checks){
  if(check.cutoff!==body.cutoff||check.findingCount!==check.findings.length)throw new Error('Incomplete snapshot check');
 }
 return body;
}
function signingKey():string{
 const key=process.env.CONTROL_SNAPSHOT_SIGNING_KEY;
 if(!key||key.length<32)throw new Error('Independent snapshot signing key required');
 return key;
}
function signature(keyId:string,canonicalHash:string):string{
 return createHmac('sha256',signingKey()).update(canonicalJson({domain:'isaflow:audit-snapshot:v1',keyId,canonicalHash})).digest('hex');
}
/** Stable retained evidence identity; rendered PDF bytes are deliberately a separate export artifact. */
export function sealAuditSnapshot(input:unknown):SealedAuditSnapshot{
 const canonicalData=canonicalJson(normalize(input)),canonicalHash=sha(canonicalData);
 const keyId=process.env.CONTROL_SNAPSHOT_KEY_ID??'current';
 return{version:1,keyId,canonicalData,canonicalHash,authentication:signature(keyId,canonicalHash)};
}
/** A database attacker replacing records and the adjacent plain hash cannot forge this authentication. */
export function verifyAuditSnapshot(input:SealedAuditSnapshot,expected:{companyId:string;snapshotId:string}):AuditSnapshotData{
 // Authenticate and parse the same detached bytes; accessors are not trusted storage data.
 const sealed=envelopeSchema.parse(JSON.parse(canonicalJson(input)));
 const identity=identitySchema.parse(JSON.parse(canonicalJson(expected)));
 if(sealed.version!==1||sealed.keyId!==(process.env.CONTROL_SNAPSHOT_KEY_ID??'current')
  ||typeof sealed.canonicalData!=='string'||Buffer.byteLength(sealed.canonicalData)>MAX_CANONICAL_BYTES
  ||!hash.safeParse(sealed.canonicalHash).success||!hash.safeParse(sealed.authentication).success
  ||sha(sealed.canonicalData)!==sealed.canonicalHash)throw new Error('Snapshot authentication failed');
 if(!timingSafeEqual(Buffer.from(signature(sealed.keyId,sealed.canonicalHash),'hex'),Buffer.from(sealed.authentication,'hex')))
  throw new Error('Snapshot authentication failed');
 const body=normalize(JSON.parse(sealed.canonicalData));
 if(body.companyId!==identity.companyId||body.snapshotId!==identity.snapshotId||canonicalJson(body)!==sealed.canonicalData)
  throw new Error('Snapshot identity or canonical data changed');
 freezeRetained(body);verifiedSnapshots.add(body);return body;
}
/** Call with the verified sealed snapshot; never substitute a mutable source document reference. */
export function verifySnapshotArtifact(snapshot:AuditSnapshotData,id:string,bytes:Uint8Array):void{
 if(!verifiedSnapshots.has(snapshot))throw new Error('Verified snapshot material required');
 const evidence=snapshot.evidence.find(item=>item.id===id);
 if(!evidence||evidence.byteLength!==bytes.byteLength||evidence.sha256!==sha(bytes))throw new Error('Retained snapshot artifact changed or missing');
}
