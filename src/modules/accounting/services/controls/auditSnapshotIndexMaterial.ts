import {setImmediate} from 'node:timers/promises';
import {canonicalJson} from './canonical';
import {verifyAuditSnapshot,type SealedAuditSnapshot} from './auditSnapshotSeal';
import {copySnapshotArtifacts,type SnapshotArtifactBytes} from './auditSnapshotPublicationMaterial';
import {indexCryptography,indexHash} from './auditSnapshotIndexCrypto';
import {indexBudget,deriveIndexPermissions,detachIndexValue,indexHeader,indexIdentity,indexItem,chunkSchema} from './auditSnapshotIndexValidation';
import {SNAPSHOT_INDEX_LIMITS,SNAPSHOT_INDEX_SECTIONS,type SnapshotIndexEnvelope,type SnapshotIndexHeader,type SnapshotIndexItem,type SnapshotIndexMaterial,type SnapshotIndexSection} from './auditSnapshotIndexContract';
const headers=new WeakSet<SnapshotIndexHeader>(),items=new WeakSet<SnapshotIndexItem>();
function sameIdentity(left:{companyId:string;snapshotId:string;canonicalHash:string},right:typeof left){return left.companyId===right.companyId&&left.snapshotId===right.snapshotId&&left.canonicalHash===right.canonicalHash;}
/** Pure background producer; publication separately checks current authority and owned saved request. */
export async function buildSnapshotIndex(sealed:SealedAuditSnapshot,sourceArtifacts:readonly SnapshotArtifactBytes[],permissions:string[],options?:{signal?:AbortSignal;deadlineAt?:number}):Promise<SnapshotIndexMaterial>{
 const check=indexBudget(options);check();
 const safeSeal=detachIndexValue(sealed),provided=detachIndexValue(permissions),artifacts=copySnapshotArtifacts(sourceArtifacts);
 if(typeof safeSeal.canonicalData!=='string'||Buffer.byteLength(safeSeal.canonicalData)>100*1024*1024)throw new Error('Snapshot canonical resource limit');
 const claimed=JSON.parse(safeSeal.canonicalData) as {companyId:string;snapshotId:string};
 const snapshot=verifyAuditSnapshot(safeSeal,{companyId:claimed.companyId,snapshotId:claimed.snapshotId});
 const required=deriveIndexPermissions(snapshot,provided),byId=new Map(artifacts.map(artifact=>[artifact.id,artifact.bytes]));
 if(artifacts.length!==snapshot.evidence.length)throw new Error('Snapshot artifact population incomplete');
 for(const evidence of snapshot.evidence){
  const bytes=byId.get(evidence.id);if(!bytes||bytes.byteLength!==evidence.byteLength||indexHash(bytes)!==evidence.sha256)throw new Error('Snapshot artifact changed or missing');
 }
 check();await setImmediate();check();
 const identity={companyId:snapshot.companyId,snapshotId:snapshot.snapshotId,canonicalHash:safeSeal.canonicalHash};
 const header=indexHeader.parse({...identity,version:1,permissions:required,counts:{records:snapshot.records.length,checks:snapshot.checks.length,
  findings:snapshot.checks.reduce((sum,check)=>sum+check.findings.length,0),evidence:snapshot.evidence.length,gaps:snapshot.evidenceGaps?.length??0}});
 const crypto=indexCryptography(),material:SnapshotIndexMaterial={header,protectedHeader:crypto.seal('header',header),items:[]};
 async function add(section:SnapshotIndexSection,ordinal:number,value:unknown){
  check();const bytes=Buffer.from(canonicalJson(value)),chunkCount=Math.ceil(bytes.byteLength/SNAPSHOT_INDEX_LIMITS.chunkBytes);
  const item=indexItem.parse({...identity,section,ordinal,byteLength:bytes.byteLength,sha256:indexHash(bytes),chunkCount});
  const chunks:SnapshotIndexEnvelope[]=[];
  for(let chunkOrdinal=0;chunkOrdinal<chunkCount;chunkOrdinal++){
   check();const offset=chunkOrdinal*SNAPSHOT_INDEX_LIMITS.chunkBytes;
   chunks.push(crypto.seal('chunk',{item,chunkOrdinal,bytesBase64:bytes.subarray(offset,offset+SNAPSHOT_INDEX_LIMITS.chunkBytes).toString('base64')}));
   if(chunkOrdinal%4===3){await setImmediate();check();}
  }
  material.items.push({section,ordinal,protectedItem:crypto.seal('item',item),chunks});
  if(material.items.length%64===0){await setImmediate();check();}
 }
 for(let i=0;i<snapshot.records.length;i++)await add('records',i,snapshot.records[i]);
 let findingOrdinal=0;
 for(let i=0;i<snapshot.checks.length;i++){
  const {findings,...summary}=snapshot.checks[i]!;await add('checks',i,summary);
  for(let findingIndex=0;findingIndex<findings.length;findingIndex++)await add('findings',findingOrdinal++,{checkId:summary.checkId,findingIndex,data:findings[findingIndex]});
 }
 for(let i=0;i<snapshot.evidence.length;i++){const evidence=snapshot.evidence[i]!;await add('evidence',i,{...evidence,bytesBase64:Buffer.from(byId.get(evidence.id)!).toString('base64')});}
 for(let i=0;i<(snapshot.evidenceGaps?.length??0);i++)await add('gaps',i,snapshot.evidenceGaps![i]);
 check();return material;
}
export function openSnapshotIndexHeader(envelope:SnapshotIndexEnvelope,expected:{companyId:string;snapshotId:string}):SnapshotIndexHeader{
 const identity=indexIdentity.omit({canonicalHash:true}).strict().parse(detachIndexValue(expected));
 const header=indexHeader.parse(indexCryptography().open('header',envelope));
 if(header.companyId!==identity.companyId||header.snapshotId!==identity.snapshotId)throw new Error('Index header identity changed');
 Object.freeze(header.permissions);Object.freeze(header.counts);Object.freeze(header);headers.add(header);return header;
}
export function openSnapshotIndexItem(envelope:SnapshotIndexEnvelope,header:SnapshotIndexHeader,section:SnapshotIndexSection,ordinal:number):SnapshotIndexItem{
 if(!headers.has(header)||!SNAPSHOT_INDEX_SECTIONS.includes(section)||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=header.counts[section])throw new Error('Verified index header and ordinal required');
 const item=indexItem.parse(indexCryptography().open('item',envelope));
 if(!sameIdentity(item,header)||item.section!==section||item.ordinal!==ordinal)throw new Error('Index item identity changed');
 Object.freeze(item);items.add(item);return item;
}
export function openSnapshotIndexChunk(envelope:SnapshotIndexEnvelope,item:SnapshotIndexItem,chunkOrdinal:number):Uint8Array{
 if(!items.has(item)||!Number.isSafeInteger(chunkOrdinal)||chunkOrdinal<0||chunkOrdinal>=item.chunkCount)throw new Error('Verified index item and chunk ordinal required');
 const chunk=chunkSchema.parse(indexCryptography().open('chunk',envelope));
 if(canonicalJson(chunk.item)!==canonicalJson(item)||chunk.chunkOrdinal!==chunkOrdinal)throw new Error('Index chunk identity changed');
 const bytes=Buffer.from(chunk.bytesBase64,'base64'),expected=Math.min(SNAPSHOT_INDEX_LIMITS.chunkBytes,item.byteLength-chunkOrdinal*SNAPSHOT_INDEX_LIMITS.chunkBytes);
 if(bytes.length!==expected||bytes.toString('base64')!==chunk.bytesBase64)throw new Error('Index chunk length or encoding changed');
 return new Uint8Array(bytes);
}
