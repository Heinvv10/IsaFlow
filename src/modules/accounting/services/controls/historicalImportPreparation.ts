import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {protectChangeValues} from './changeProtection';
import {recordCommittedChange} from './changeEventService';
import {assertHistoricalImportAuthority} from './historicalImportAuthority';
import {historicalHash,readHistoricalImportSource} from './historicalImportSourceService';
import {loadHistoricalImportCurrentFacts} from './historicalImportCurrentFacts';
import {materializeHistoricalImportOperation} from './historicalImportMaterializer';
import type {ControlTx} from './contracts';
import type {HistoricalImportPrepareInput,HistoricalImportPrepared} from './historicalImportTypes';
type Row=Record<string,unknown>;
/** Binds an entire owned artifact group; preparation never posts or activates a subledger document. */
export async function prepareHistoricalImport(ctx:ControlTx,input:HistoricalImportPrepareInput):Promise<HistoricalImportPrepared>{
 assertControlTx(ctx);
 if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['sourceSystem','sourceKey','kind','mode','accountingDate','evidenceId','sourceRecordIds'].includes(key)))throw new Error('Invalid historical preparation input');
 await assertHistoricalImportAuthority(ctx,input.kind,'write');
 const source=await readHistoricalImportSource(ctx,input.evidenceId),normalized=source.normalized;
 if(['sourceSystem','sourceKey','kind','mode','accountingDate'].some(key=>input[key as keyof HistoricalImportPrepareInput]!==normalized[key as keyof typeof normalized]))throw new Error('Historical preparation differs from source group');
 if(!Array.isArray(input.sourceRecordIds)||input.sourceRecordIds.length>1000||new Set(input.sourceRecordIds).size!==input.sourceRecordIds.length
  ||canonicalJson([...input.sourceRecordIds].sort())!==canonicalJson(normalized.records.map(row=>row.recordId)))throw new Error('Historical preparation must include the exact source record population');
 return withSavepoint('historical_import_prepare',async()=>{
  const current=await loadHistoricalImportCurrentFacts(ctx,normalized);
  const id=randomUUID(),p=ctx.principal,grant=p.authMethod==='cookie'?null:p.authMethod==='pat'?p.connectionId:p.grantId;
  const body={companyId:p.companyId,importId:id,sourceId:source.sourceId,requesterPersonId:p.personId,requesterAuthMethod:p.authMethod,
   requesterGrantId:grant,requesterGrantedScopes:p.grantedScopes,contentHash:source.contentHash,normalizedHash:source.normalizedHash,normalized,resolvedPlan:current.plan};
  const payloadHash=historicalHash(canonicalJson(body)),envelope=protectChangeValues('historical_import',null,body).protectedPayload;
  const inserted=await ctx.sql`INSERT INTO control_historical_imports(company_id,id,requester_person_id,source_id,requester_auth_method,requester_grant_id,requester_granted_scopes,
   source_system,source_key,kind,mode,accounting_date,currency,amount,payload_envelope,payload_hash)
   VALUES(${p.companyId}::uuid,${id}::uuid,${p.personId},${source.sourceId}::uuid,${p.authMethod},${grant}::uuid,
    ${p.grantedScopes===null?null:[...p.grantedScopes]}::text[],${normalized.sourceSystem},${normalized.sourceKey},${normalized.kind},${normalized.mode},${normalized.accountingDate}::date,
    ${normalized.currency},${normalized.amount},${JSON.stringify(envelope)}::jsonb,${payloadHash}) ON CONFLICT(company_id,source_system,source_key,kind) DO NOTHING RETURNING id` as Row[];
  const existing=inserted.length?inserted:await ctx.sql`SELECT id,requester_person_id FROM control_historical_imports
   WHERE company_id=${p.companyId}::uuid AND source_system=${normalized.sourceSystem} AND source_key=${normalized.sourceKey} AND kind=${normalized.kind}` as Row[];
  if(existing.length!==1||(!inserted.length&&existing[0]!.requester_person_id!==p.personId))throw new Error('Historical source identity belongs to a different requester');
  const importId=String(existing[0]!.id);
  if(inserted.length)await recordCommittedChange(ctx,{entityType:'historical_import',entityId:importId,previousVersion:null,newVersion:1,action:'historical_import.prepared',accountingDate:normalized.accountingDate,
   before:null,after:{status:'prepared',sourceId:source.sourceId,contentHash:source.contentHash,normalizedHash:source.normalizedHash,amount:normalized.amount,currency:normalized.currency},bindingHash:payloadHash,protectedEvidenceRef:null});
  const material=await materializeHistoricalImportOperation(ctx,{entityType:'historical_import',entityId:importId,operation:'historical_import.post'});
  const facts=material.observedSources[0]!.facts as {source:{contentHash:string;normalizedHash:string}};
  if(facts.source.contentHash!==source.contentHash||facts.source.normalizedHash!==source.normalizedHash)throw new Error('Historical source key already exists with different evidence');
  return{importId,operation:'historical_import.post',amount:normalized.amount,currency:'ZAR',accountingDate:normalized.accountingDate,
   fingerprint:material.observedSources[0]!.fingerprint,requiresApproval:true};
 });
}
