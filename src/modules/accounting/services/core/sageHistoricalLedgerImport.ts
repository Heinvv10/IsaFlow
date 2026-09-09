import {createHash} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {requireControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {assertHistoricalImportAuthority} from '../controls/historicalImportAuthority';
import {readHistoricalImportSource} from '../controls/historicalImportSourceService';
import {executeHistoricalImport} from '../controls/historicalImportExecution';
import type {MigrationRun} from './sageMigrationService';
export interface SavedSageLedgerImports {imports:Array<{importId:string;approvalId:string}>}
interface Manifest {importId:string;sourceId:string;sourceRecordIds:string[];journalEntryId:string}
interface RunRow {
 id:string;run_type:string;status:string;total_records:number;processed:number;succeeded:number;failed:number;skipped:number;
 started_by:string;started_at:Date|string;completed_at:Date|string;details:unknown;
}
function detachedBindings(input:SavedSageLedgerImports|undefined){
 if(!input)throw new Error('Sage ledger posting requires saved independently approved imports');
 const body=JSON.parse(canonicalJson(input)) as SavedSageLedgerImports;
 if(Object.keys(body).some(key=>key!=='imports')||!Array.isArray(body.imports)||body.imports.length<1||body.imports.length>100
  ||body.imports.some(item=>!item||Object.keys(item).some(key=>!['importId','approvalId'].includes(key))||!UUID_RE.test(item.importId)||!UUID_RE.test(item.approvalId)))throw new Error('Invalid saved Sage ledger imports');
 const imports=body.imports.map(item=>({importId:item.importId.toLowerCase(),approvalId:item.approvalId.toLowerCase()})).sort((a,b)=>a.importId<b.importId?-1:1);
 if(new Set(imports.map(item=>item.importId)).size!==imports.length)throw new Error('Duplicate saved Sage import identity');return imports;
}
/** Deterministic bookkeeping identity only; it never substitutes for approval or an economic receipt. */
function runIdentity(companyId:string,userId:string,imports:Array<{importId:string}>){
 const hash=createHash('sha256').update(canonicalJson({domain:'isaflow:sage-ledger-run:v1',companyId,userId,importIds:imports.map(item=>item.importId)})).digest('hex');
 return`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
const timestamp=(value:Date|string)=>new Date(value).toISOString();
/** The legacy entry point executes only explicitly saved, independently approved actual Sage column groups. */
export async function importLedgerTransactions(companyId:string,userId:string,input?:SavedSageLedgerImports):Promise<MigrationRun>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Sage importer differs from authenticated principal');
 const imports=detachedBindings(input);await assertHistoricalImportAuthority(ctx,'gl','write');
 return withSavepoint('sage_ledger_approved_batch',async()=>{
  const sources=new Map<string,{sourceId:string;sourceRecordIds:string[]}>(),recordIds=new Set<string>();
  for(const item of imports){
   const intents=await ctx.sql`SELECT source_id,requester_person_id,kind,mode FROM control_historical_imports
    WHERE company_id=${companyId}::uuid AND id=${item.importId}::uuid` as {source_id:string;requester_person_id:string;kind:string;mode:string}[];
   const intent=intents[0];
   if(intents.length!==1||!intent||intent.requester_person_id!==userId||intent.kind!=='gl'||intent.mode!=='post_journal')throw new Error('Saved Sage ledger import unavailable');
   const source=await readHistoricalImportSource(ctx,intent.source_id);
   if(source.normalized.sourceSystem!=='sage'||source.artifact?.extractor.id!=='sage_columns')throw new Error('Saved Sage column evidence is required');
   const sourceRecordIds=source.normalized.records.map(row=>row.recordId).sort();
   for(const id of sourceRecordIds){if(recordIds.has(id))throw new Error('Repeated Sage economic source row');recordIds.add(id);}
   sources.set(item.importId,{sourceId:source.sourceId,sourceRecordIds});
  }
  const manifest:Manifest[]=[];
  for(const item of imports){
   const effect=await executeHistoricalImport(ctx,{entityType:'historical_import',entityId:item.importId,operation:'historical_import.post'},item.approvalId);
   const source=sources.get(item.importId)!;
   if(!effect.sageSourceRecordIds||canonicalJson([...effect.sageSourceRecordIds].sort())!==canonicalJson(source.sourceRecordIds))throw new Error('Sage economic receipt differs from original source');
   manifest.push({importId:item.importId,...source,journalEntryId:effect.journalEntryId});
  }
  const runId=runIdentity(companyId,userId,imports),details={version:1,kind:'approved_sage_ledger',imports:manifest},count=imports.length;
  await ctx.sql`INSERT INTO gl_migration_runs(id,company_id,run_type,status,total_records,processed,succeeded,failed,skipped,started_by,completed_at,details)
   VALUES(${runId}::uuid,${companyId}::uuid,'ledger_import','completed',${count},${count},${count},0,0,${userId},clock_timestamp(),${JSON.stringify(details)}::jsonb)
   ON CONFLICT(id) DO NOTHING`;
  const rows=await ctx.sql`SELECT * FROM gl_migration_runs WHERE company_id=${companyId}::uuid AND id=${runId}::uuid FOR SHARE` as RunRow[];
  const row=rows[0];
  if(rows.length!==1||!row||row.started_by!==userId||row.run_type!=='ledger_import'||row.status!=='completed'||row.total_records!==count
   ||row.processed!==count||row.succeeded!==count||row.failed!==0||row.skipped!==0||canonicalJson(row.details)!==canonicalJson(details))throw new Error('Sage migration run differs from verified economic receipts');
  return{id:row.id,runType:row.run_type,status:row.status,totalRecords:row.total_records,processed:row.processed,succeeded:row.succeeded,
   failed:row.failed,skipped:row.skipped,startedAt:timestamp(row.started_at),completedAt:timestamp(row.completed_at)};
 });
}
