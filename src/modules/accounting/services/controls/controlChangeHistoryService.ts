import {createHash} from 'node:crypto';
import {z} from 'zod';
import {resolveEffectivePermissions} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {openProtectedChange} from './changeProtection';
import {openHistoryCursor,sealHistoryCursor} from './controlChangeHistoryCursor';
import {assertHistoryEntity,assertHistoryOperationSources} from './controlChangeHistoryPolicy';
import {projectHistoryValues} from './controlChangeHistoryProjection';
import {assertJournalMergeHistorySources} from './controlChangeHistoryJournalSources';
import type {ControlTx} from './contracts';
const inputSchema=z.object({entityType:z.string().min(1).max(80),entityId:z.string().min(1).max(80),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(2048).optional()}).strict();
export interface HistoryInput{entityType:string;entityId:string;limit?:number;cursor?:string}
type Row={id:string;new_version:string|number;previous_version:string|number|null;occurred_at:Date|string;accounting_date:Date|string|null;action:string;operation_id:string;person_id:string;connection_id:string|null;grant_id:string|null;acting_firm_id:string|null;request_id:string;provenance:'human'|'agent'|'job';byte_length:string|number|null};
const integer=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid recorded history version');return n;};
const iso=(value:Date|string)=>value instanceof Date?value.toISOString():new Date(value).toISOString();
/** Read-only, version-keyset history of exact retained changes. No reconstruction of missing historical evidence. */
export async function readControlEntityHistory(ctx:ControlTx,input:HistoryInput){
 const options=inputSchema.parse(JSON.parse(canonicalJson(input)));assertControlTx(ctx);
 const {entityType,entityId}=options,limit=options.limit??50,company=ctx.principal.companyId;
 await assertHistoryEntity(ctx,entityType,entityId);
 const rights=await resolveEffectivePermissions(ctx),permissionsHash=createHash('sha256').update(canonicalJson([...rights.permissions].sort())).digest('hex');
 const cursor=options.cursor?openHistoryCursor(options.cursor):null;
 if(cursor&&(cursor.companyId!==company||cursor.entityType!==entityType||cursor.entityId!==entityId||cursor.permissionsHash!==permissionsHash))throw new Error('History cursor no longer matches authorized query');
 const [latest]=await ctx.sql`SELECT
  (SELECT max(version) FROM control_entity_versions WHERE company_id=${company}::uuid AND entity_type=${entityType} AND lower(entity_id)=lower(${entityId})) AS version,
  (SELECT max(new_version) FROM control_change_events WHERE company_id=${company}::uuid AND entity_type=${entityType} AND lower(entity_id)=lower(${entityId})) AS event_version` as {version:string|number|null;event_version:string|number|null}[];
 const currentVersion=Math.max(integer(latest?.version??0),integer(latest?.event_version??0));
 const throughVersion=cursor?.throughVersion??currentVersion;
 if(throughVersion>currentVersion)throw new Error('History population changed');
 const [count]=await ctx.sql`SELECT count(*)::text AS count,min(new_version)::text AS first,max(new_version)::text AS last,min(occurred_at) AS since,
  count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM control_protected_evidence p WHERE p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND lower(p.entity_id)=lower(e.entity_id)))::text AS missing
  FROM control_change_events e WHERE e.company_id=${company}::uuid AND e.entity_type=${entityType} AND lower(e.entity_id)=lower(${entityId}) AND e.new_version<=${throughVersion}` as {count:string;first:string|null;last:string|null;since:Date|string|null;missing:string}[];
 const rows=await ctx.sql`SELECT e.id,e.new_version,e.previous_version,e.occurred_at,e.accounting_date,e.action,e.operation_id,e.person_id,e.connection_id,e.grant_id,e.acting_firm_id,e.request_id,e.provenance,
  octet_length(p.ciphertext)::text AS byte_length FROM control_change_events e LEFT JOIN control_protected_evidence p
  ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND lower(p.entity_id)=lower(e.entity_id)
  WHERE e.company_id=${company}::uuid AND e.entity_type=${entityType} AND lower(e.entity_id)=lower(${entityId})
   AND e.new_version>${cursor?.lastVersion??0} AND e.new_version<=${throughVersion} ORDER BY e.new_version LIMIT ${limit+1}` as Row[];
 await assertHistoryOperationSources(ctx,[...new Set(rows.slice(0,limit).map(row=>row.operation_id))]);
 const page:Row[]=[];let pageBytes=0;
 for(const row of rows.slice(0,limit)){const size=integer(row.byte_length??0);if(pageBytes+size>2*1024*1024)break;page.push(row);pageBytes+=size;}
 const eventCount=integer(count?.count??0),versionGaps=(throughVersion>0&&latest?.version==null)||eventCount!==throughVersion||integer(count?.last??0)!==throughVersion||(eventCount>0&&integer(count?.first)!==1);
 const coverage={source:'control_change_events' as const,historical:eventCount?'recorded_since' as const:'untracked' as const,
  recordedSince:count?.since?iso(count.since):null,throughVersion,eventCount,versionGaps,missingProtectedEvidence:integer(count?.missing??0),status:versionGaps||integer(count?.missing??0)>0?'incomplete' as const:'complete' as const};
 if(!page.length&&rows.length)return{available:false as const,code:'RESOURCE_LIMIT' as const,requiredDelivery:'async' as const,entity:{entityType,entityId},items:[],nextCursor:options.cursor??null,coverage,eventId:rows[0]!.id,byteLength:integer(rows[0]!.byte_length)};
 const evidence=page.length?await ctx.sql`SELECT e.id,p.ciphertext,p.key_id,p.envelope_version FROM control_change_events e JOIN control_protected_evidence p
  ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND lower(p.entity_id)=lower(e.entity_id)
  WHERE e.company_id=${company}::uuid AND e.entity_type=${entityType} AND lower(e.entity_id)=lower(${entityId}) AND e.id=ANY(${page.map(row=>row.id)}::uuid[])` as {id:string;ciphertext:string;key_id:string;envelope_version:number}[]:[];
 const byId=new Map(evidence.map(row=>[row.id,row]));
 const decoded=new Map<string,ReturnType<typeof openProtectedChange>>();
 for(const row of page){
  const protectedRow=byId.get(row.id);
  const values=protectedRow?openProtectedChange({version:protectedRow.envelope_version as 1,keyId:protectedRow.key_id,ciphertext:protectedRow.ciphertext}):{before:null,after:null};
  await assertJournalMergeHistorySources(ctx,{entityType,entityId,action:row.action},values);
  if(protectedRow)decoded.set(row.id,values);
 }
 const items=page.map(row=>{
  const protectedRow=byId.get(row.id),retained=!!protectedRow;
  const values=retained?projectHistoryValues(decoded.get(row.id)!):{before:null,after:null,redactedPaths:[] as string[]};
  return{eventId:row.id,occurredAt:iso(row.occurred_at),accountingDate:row.accounting_date===null?null:iso(row.accounting_date).slice(0,10),previousVersion:row.previous_version===null?null:integer(row.previous_version),newVersion:integer(row.new_version),action:row.action,operationId:row.operation_id,
   actor:{personId:row.person_id,connectionId:row.connection_id,grantId:row.grant_id,actingFirmId:row.acting_firm_id,requestId:row.request_id,provenance:row.provenance,recorded:true as const},...values,protectedEvidence:{retained,availability:retained?'available' as const:'missing' as const}};
 });
 const nextCursor=rows.length>page.length?sealHistoryCursor({version:1,companyId:company,entityType,entityId,permissionsHash,throughVersion,lastVersion:items.at(-1)!.newVersion}):null;
 return{available:true as const,entity:{entityType,entityId},items,nextCursor,coverage};
}
