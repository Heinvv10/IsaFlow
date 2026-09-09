import {randomUUID} from 'node:crypto';
import {assertControlTx} from './context';
import {UUID_RE} from '@/lib/validation';
import {assertHistoricalImportAuthority} from './historicalImportAuthority';
import {materializeHistoricalImportOperation} from './historicalImportMaterializer';
import {executeControlledOperation} from './approvalExecutionService';
import {registerGeneratedJournal} from './generatedJournalPermit';
import {replayKnownOperationEffect} from './operationReceiptReplay';
import {postJournalEntry} from '../gl/journalEntryPostingService';
import {writeHistoricalImportDocument} from './historicalImportDocumentWriter';
import type {ControlTx,OperationRef} from './contracts';
import type {HistoricalImportKind,HistoricalImportMode,HistoricalImportNormalized} from './historicalImportTypes';
import type {loadHistoricalImportCurrentFacts} from './historicalImportCurrentFacts';
type Row=Record<string,unknown>;
type Facts=Awaited<ReturnType<typeof loadHistoricalImportCurrentFacts>>&{source:{normalized:HistoricalImportNormalized;contentHash:string}};
export interface HistoricalImportEffect {
 importId:string;kind:HistoricalImportKind;mode:HistoricalImportMode;journalEntryId:string;documentId?:string;
 amount:string;currency:'ZAR';accountingDate:string;
}
function postingActor(ctx:ControlTx){
 assertControlTx(ctx);const principal=ctx.principal;
 if(principal.authMethod==='pat'||principal.authMethod==='oauth'){
  const token=principal.authMethod==='pat'?principal.connectionId:principal.grantId;
  if(principal.provenance!=='agent'||!token)throw new Error('Historical import credential provenance is unavailable');
  return{actorType:'agent',actorTokenJti:token,postingAgent:'mcp:historical_import:v1'};
 }
 if(principal.authMethod!=='cookie'||principal.provenance!=='human')throw new Error('Historical import requires authenticated member provenance');
 return{actorType:'human',actorTokenJti:null,postingAgent:`human:${principal.personId}`};
}
async function receipt(ctx:ControlTx,ref:OperationRef):Promise<HistoricalImportEffect|null>{
 const rows=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND entity_type='historical_import' AND entity_id=${ref.entityId} AND operation='historical_import.post' LIMIT 2` as {id:string;result:HistoricalImportEffect}[];
 if(!rows.length)return null;
 const row=rows[0]!;if(rows.length!==1||row.result.importId!==ref.entityId||!UUID_RE.test(row.result.journalEntryId))throw new Error('Historical import receipt association invalid');
 const journals=await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${ctx.principal.companyId}::uuid
  AND id=${row.result.journalEntryId}::uuid AND status='posted' AND reversed_at IS NULL FOR SHARE`;
 if(journals.length!==1)throw new Error('Historical import receipt journal changed');
 if(row.result.documentId){
  const documents=row.result.kind==='customer_invoice'?await ctx.sql`SELECT id FROM customer_invoices WHERE company_id=${ctx.principal.companyId}::uuid
   AND id=${row.result.documentId}::uuid AND gl_journal_entry_id=${row.result.journalEntryId}::uuid AND status<>'cancelled' FOR SHARE`
   :await ctx.sql`SELECT id FROM supplier_invoices WHERE company_id=${ctx.principal.companyId}::uuid
   AND id=${row.result.documentId}::uuid AND gl_journal_entry_id=${row.result.journalEntryId}::uuid AND status<>'cancelled' FOR SHARE`;
  if(documents.length!==1)throw new Error('Historical import receipt document changed');
 }
 return replayKnownOperationEffect<HistoricalImportEffect>(ctx,ref,row.id);
}
/** The only historical financial write accepts persisted source identity and independent approval. */
export async function executeHistoricalImport(ctx:ControlTx,ref:OperationRef,approvalId?:string):Promise<HistoricalImportEffect>{
 assertControlTx(ctx);
 if(ref.entityType!=='historical_import'||ref.operation!=='historical_import.post'||!UUID_RE.test(ref.entityId))throw new Error('Invalid historical import operation');
 const company=ctx.principal.companyId,user=ctx.principal.personId;
 const [intent]=await ctx.sql`SELECT requester_person_id,kind FROM control_historical_imports WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid` as Row[];
 if(!intent||intent.requester_person_id!==user)throw new Error('Historical import belongs to another requester or is unavailable');
 await assertHistoricalImportAuthority(ctx,intent.kind as HistoricalImportKind,'write');
 if(!approvalId){const prior=await receipt(ctx,ref);if(prior)return prior;throw new Error('Independent operation approval is required');}
 return executeControlledOperation(ctx,ref,approvalId,async permit=>{
  const previous=await ctx.sql`SELECT id FROM control_operation_effects WHERE company_id=${company}::uuid
   AND entity_type='historical_import' AND entity_id=${ref.entityId} AND operation='historical_import.post'`;
  if(previous.length)throw new Error('Historical source already executed');
  const material=await materializeHistoricalImportOperation(ctx,ref),facts=material.observedSources[0]!.facts as unknown as Facts;
  const source=facts.source.normalized;
  if(permit.accountingDate!==source.accountingDate||permit.amount!==source.amount||permit.currency!==source.currency)throw new Error('Historical permit differs from exact source');
  let journalEntryId=source.existingJournalId;
  if(source.mode==='post_journal'){
   journalEntryId=randomUUID();const actor=postingActor(ctx);
   await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,posting_agent,source_document_hash,actor_type,actor_token_jti)
    VALUES(${journalEntryId}::uuid,${company}::uuid,${`HI-${ref.entityId}`},${source.accountingDate}::date,${facts.period.id}::uuid,
     ${`Historical import ${source.sourceSystem}: ${source.sourceKey}`},'auto_gl_import',${ref.entityId}::uuid,'draft',${user}::uuid,${actor.postingAgent},${facts.source.contentHash},${actor.actorType},${actor.actorTokenJti})`;
   for(const line of facts.plan)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,vat_type)
    VALUES(${company}::uuid,${journalEntryId}::uuid,${line.glAccountId}::uuid,${line.debit},${line.credit},${line.description},${line.vatType??null})`;
   const parentControl={permit,parent:ref};await registerGeneratedJournal(ctx,parentControl,journalEntryId,'journal.post');
   await postJournalEntry(company,journalEntryId,user,{parentControl});
  }
  if(!journalEntryId)throw new Error('Historical exact journal is unavailable');
  const documentId=source.document?await writeHistoricalImportDocument(ctx,permit,ref,source,journalEntryId):undefined;
  return{importId:ref.entityId,kind:source.kind,mode:source.mode,journalEntryId,...(documentId?{documentId}:{}),amount:source.amount,currency:source.currency,accountingDate:source.accountingDate};
 });
}
