import {isRealCalendarDate} from '@/lib/validation';
import {assertControlTx} from './context';
import {canonicalJson} from './canonical';
import {readHistoricalSageSnapshot,type HistoricalSageSnapshot,type HistoricalSageMapping,type HistoricalSageRow} from './historicalImportSageAdapter';
import type {ControlTx} from './contracts';
/** Company FK locks fence inserts; every owned row is locked to prevent UPDATE predicate phantoms. */
export async function loadSageHistoricalSnapshot(ctx:ControlTx,accountingDate:string,reference:string|null):Promise<HistoricalSageSnapshot>{
 assertControlTx(ctx);const company=ctx.principal.companyId;
 if(!isRealCalendarDate(accountingDate)||(reference!==null&&(typeof reference!=='string'||reference.length>255)))throw new Error('Invalid Sage source group identity');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 const companies=await ctx.sql`SELECT id FROM companies WHERE id=${company}::uuid FOR UPDATE`;
 if(companies.length!==1)throw new Error('Sage source tenant unavailable');
 const allRows=await ctx.sql`SELECT id FROM sage_ledger_transactions WHERE company_id=${company}::uuid ORDER BY id LIMIT 100001 FOR SHARE`;
 const allMappings=await ctx.sql`SELECT id FROM sage_accounts WHERE company_id=${company}::uuid ORDER BY id LIMIT 100001 FOR SHARE`;
 if(allRows.length>100000||allMappings.length>100000)throw new Error('Sage source population exceeds synchronous 100000-row lock bound');
 const rows=await ctx.sql`SELECT id,sage_id AS "sageId",account_code AS "accountCode",transaction_date::text AS "accountingDate",
  description,debit::text,credit::text,reference,migration_status AS "migrationStatus",gl_journal_entry_id AS "journalEntryId",
  (to_jsonb(s)->'raw_data')::text AS "rawDataText"
  FROM sage_ledger_transactions s WHERE company_id=${company}::uuid AND transaction_date=${accountingDate}::date
   AND reference IS NOT DISTINCT FROM ${reference} ORDER BY id LIMIT 1001 FOR SHARE` as Array<HistoricalSageRow&{rawDataText:string|null}>;
 if(!rows.length||rows.length>1000)throw new Error('Sage source group population is missing or exceeds bound');
 // Preserve a richer persisted artifact only through an extractor that understands it.
 if(rows.some(row=>row.rawDataText!==null))throw new Error('Persisted Sage raw JSON requires its dedicated verified extractor');
 const codes=[...new Set(rows.map(row=>row.accountCode))];
 const mappings=await ctx.sql`SELECT sa.id,sa.account_code AS "sourceAccountCode",sa.gl_account_id AS "glAccountId",ga.account_code AS "glAccountCode"
  FROM sage_accounts sa LEFT JOIN gl_accounts ga ON ga.company_id=sa.company_id AND ga.id=sa.gl_account_id
  WHERE sa.company_id=${company}::uuid AND sa.account_code=ANY(${codes}::text[]) ORDER BY sa.id LIMIT 1001 FOR SHARE OF sa` as Array<HistoricalSageMapping>;
 if(new Set(mappings.map(mapping=>mapping.sourceAccountCode)).size!==mappings.length)throw new Error('Ambiguous persisted Sage account mapping');
 return{version:1,table:'sage_ledger_transactions',companyId:company,
  rows:rows.map(({rawDataText:_raw,...row})=>row),mappings:mappings.filter(mapping=>mapping.glAccountId!==null&&mapping.glAccountCode!==null)};
}
export async function assertCurrentSageHistoricalSnapshot(ctx:ControlTx,bytes:Buffer,sourceId?:string){
 const saved=readHistoricalSageSnapshot(bytes,ctx.principal.companyId),first=saved.rows[0]!;
 if(saved.rows.some(row=>row.accountingDate!==first.accountingDate||row.reference!==first.reference))throw new Error('Sage source snapshot must contain one complete group');
 const current=await loadSageHistoricalSnapshot(ctx,first.accountingDate,first.reference);
 if(canonicalJson(current)!==canonicalJson(saved))throw new Error('Persisted Sage source population or mapping changed');
 const prior=await ctx.sql`SELECT i.source_id FROM control_operation_effects e
  JOIN control_historical_imports i ON i.company_id=e.company_id AND i.id::text=e.entity_id
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.entity_type='historical_import' AND e.operation='historical_import.post'
   AND i.source_system='sage' AND (e.result->'sageSourceRecordIds') ?| ${saved.rows.map(row=>row.id)}::text[] LIMIT 2` as {source_id:string}[];
 if(prior.some(row=>row.source_id!==sourceId))throw new Error('Persisted Sage source records already imported');
}
