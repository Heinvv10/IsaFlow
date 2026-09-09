import {createHash} from 'node:crypto';
import {canonicalJson} from './canonical';
import {verifyAuditSnapshot,type SealedAuditSnapshot,type AuditSnapshotData} from './auditSnapshotSeal';
interface SnapshotReference {id:string;sealed:SealedAuditSnapshot}
function hash(value:unknown):string{return createHash('sha256').update(canonicalJson(value)).digest('hex');}
function changes<T,I>(first:T[],second:T[],identity:(row:T)=>I,material:(row:T)=>unknown){
 const before=new Map(first.map(row=>[canonicalJson(identity(row)),row]));
 const after=new Map(second.map(row=>[canonicalJson(identity(row)),row]));
 const added:I[]=[],removed:I[]=[],changed:Array<I&{beforeHash:string;afterHash:string}>=[];
 for(const key of [...new Set([...before.keys(),...after.keys()])].sort()){
  const old=before.get(key),current=after.get(key);
  if(old===undefined&&current!==undefined)added.push(identity(current));
  else if(old!==undefined&&current===undefined)removed.push(identity(old));
  else if(old!==undefined&&current!==undefined){
   const beforeHash=hash(material(old)),afterHash=hash(material(current));
   if(beforeHash!==afterHash)changed.push({...identity(current),beforeHash,afterHash});
  }
 }
 return{added,removed,changed};
}
function checkMaterial(check:AuditSnapshotData['checks'][number]){
 // A fresh observation time alone is not a changed rule or accounting result.
 const {capturedAt:_capturedAt,...material}=check;return material;
}
/** Internal retained-material comparison. Service callers must enforce current source-domain reads first. */
export function compareSealedAuditSnapshots(companyId:string,first:SnapshotReference,second:SnapshotReference){
 const a=verifyAuditSnapshot(first.sealed,{companyId,snapshotId:first.id});
 const b=verifyAuditSnapshot(second.sealed,{companyId,snapshotId:second.id});
 return{
  first:{id:a.snapshotId,cutoff:a.cutoff,capturedAt:a.capturedAt,canonicalHash:first.sealed.canonicalHash},
  second:{id:b.snapshotId,cutoff:b.cutoff,capturedAt:b.capturedAt,canonicalHash:second.sealed.canonicalHash},
  records:changes(a.records,b.records,row=>({source:row.source,id:row.id}),row=>row),
  checks:changes(a.checks,b.checks,row=>({checkId:row.checkId}),checkMaterial),
  evidence:changes(a.evidence,b.evidence,row=>({id:row.id}),row=>row),
  populationChanged:canonicalJson(a.populations)!==canonicalJson(b.populations),
  coverageChanged:canonicalJson([a.coverage,a.missingSources])!==canonicalJson([b.coverage,b.missingSources]),
 };
}
