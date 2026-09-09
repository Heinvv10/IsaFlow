import {createHash,randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {protectChangeValues,openProtectedChange,type ProtectedChange} from './changeProtection';
import {recordCommittedChange} from './changeEventService';
import {extractHistoricalArtifactGroup,type HistoricalArtifact} from './historicalImportArtifact';
import {assertCurrentSageHistoricalSnapshot} from './historicalImportSageSnapshotService';
import {assertHistoricalImportAuthority} from './historicalImportAuthority';
import type {ControlTx} from './contracts';
export const historicalHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Row=Record<string,unknown>;
export function decodeHistoricalImportSource(ctx:ControlTx,row:Row){
 assertControlTx(ctx);
 try{
  const body=openProtectedChange(row.payload_envelope as ProtectedChange).after;
  if(!body||row.company_id!==ctx.principal.companyId||body.companyId!==row.company_id||body.sourceId!==row.id
   ||body.contentHash!==row.content_hash||body.normalizedHash!==row.normalized_hash||body.mimeType!==row.mime_type||typeof body.bodyBase64!=='string')throw new Error('binding');
  const bytes=Buffer.from(body.bodyBase64,'base64');
  if(bytes.toString('base64')!==body.bodyBase64||bytes.length!==row.byte_length||historicalHash(bytes)!==row.content_hash)throw new Error('bytes');
  const normalized=extractHistoricalArtifactGroup(bytes,String(row.mime_type),body.artifact);
  if(normalized.records.length!==row.record_count||historicalHash(canonicalJson(normalized))!==row.normalized_hash
   ||canonicalJson(normalized)!==canonicalJson(body.normalized))throw new Error('normalization');
  return{bytes,mimeType:String(row.mime_type),normalized,contentHash:String(row.content_hash),normalizedHash:String(row.normalized_hash),sourceId:String(row.id),...(body.artifact?{artifact:body.artifact as unknown as HistoricalArtifact}:{})};
 }catch{throw new Error('Historical source evidence unavailable or changed');}
}
export async function readHistoricalImportSource(ctx:ControlTx,sourceId:string){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:imports');
 if(!UUID_RE.test(sourceId))throw new Error('Invalid historical source identity');
 const rows=await ctx.sql`SELECT * FROM control_historical_import_sources WHERE company_id=${ctx.principal.companyId}::uuid AND id=${sourceId}::uuid` as Row[];
 if(rows.length!==1)throw new Error('Historical source evidence unavailable or changed');
 const source=decodeHistoricalImportSource(ctx,rows[0]!);
 await assertHistoricalImportAuthority(ctx,source.normalized.kind,'read');
 if(source.artifact?.extractor.id==='sage_columns')await assertCurrentSageHistoricalSnapshot(ctx,source.bytes,source.sourceId);
 return source;
}
/** Actual protected source artifact; no caller-provided normalized financial body is accepted. */
export async function storeHistoricalImportSource(ctx:ControlTx,input:{bytes:Buffer;mimeType:string;artifact?:HistoricalArtifact}){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:imports');
 if(!Buffer.isBuffer(input.bytes))throw new Error('Historical source artifact bytes required');
 const artifact=input.artifact?JSON.parse(canonicalJson(input.artifact)) as HistoricalArtifact:undefined;
 const bytes=Buffer.from(input.bytes),normalized=extractHistoricalArtifactGroup(bytes,input.mimeType,artifact);
 await assertHistoricalImportAuthority(ctx,normalized.kind,'write');
 if(artifact?.extractor.id==='sage_columns')await assertCurrentSageHistoricalSnapshot(ctx,bytes);
 const id=randomUUID(),contentHash=historicalHash(bytes),normalizedHash=historicalHash(canonicalJson(normalized));
 const envelope=protectChangeValues('historical_import_source',null,{companyId:ctx.principal.companyId,sourceId:id,bodyBase64:bytes.toString('base64'),contentHash,normalizedHash,mimeType:input.mimeType,normalized,...(artifact?{artifact}:{})}).protectedPayload;
 return withSavepoint('historical_import_source',async()=>{
  await ctx.sql`INSERT INTO control_historical_import_sources(company_id,id,requester_person_id,payload_envelope,content_hash,normalized_hash,mime_type,byte_length,record_count)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${JSON.stringify(envelope)}::jsonb,${contentHash},${normalizedHash},${input.mimeType},${bytes.length},${normalized.records.length})`;
  await recordCommittedChange(ctx,{entityType:'historical_import_source',entityId:id,previousVersion:null,newVersion:1,action:'historical_import.source_staged',accountingDate:normalized.accountingDate,
   before:null,after:{sourceId:id,contentHash,normalizedHash,recordCount:normalized.records.length,byteLength:bytes.length},bindingHash:null,protectedEvidenceRef:null});
  return{sourceId:id,contentHash,normalizedHash,recordCount:normalized.records.length};
 });
}
