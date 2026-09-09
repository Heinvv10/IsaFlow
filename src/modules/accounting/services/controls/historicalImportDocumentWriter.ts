import {randomUUID} from 'node:crypto';
import {canonicalJson} from './canonical';
import {assertGeneratedJournal} from './generatedJournalPermit';
import {materializeHistoricalImportOperation} from './historicalImportMaterializer';
import Decimal from 'decimal.js';
import {assertControlledEffectPermit,type ControlledEffectPermit} from './approvalExecutionService';
import {recordCommittedChange} from './changeEventService';
import {readControlEntityVersion} from './operationVersions';
import type {ControlTx,OperationRef} from './contracts';
import type {HistoricalImportNormalized} from './historicalImportTypes';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** Imported summaries retain actual source amounts; no commercial quantities or rates are invented. */
export async function writeHistoricalImportDocument(ctx:ControlTx,permit:ControlledEffectPermit,ref:OperationRef,source:HistoricalImportNormalized,journalId:string):Promise<string>{
 assertControlledEffectPermit(ctx,permit,ref);
 if(ref.operation!=='historical_import.post'||!source.document)throw new Error('Historical document parent authority is unavailable');
 const material=await materializeHistoricalImportOperation(ctx,ref);
 const exact=(material.observedSources[0]!.facts as {source:{normalized:HistoricalImportNormalized}}).source.normalized;
 if(canonicalJson(exact)!==canonicalJson(source)||permit.amount!==source.amount||permit.accountingDate!==source.accountingDate||permit.currency!==source.currency)throw new Error('Historical document differs from authorized source');
 if(source.mode==='post_journal')assertGeneratedJournal(ctx,{permit,parent:ref},journalId,'journal.post');
 else if(journalId!==source.existingJournalId)throw new Error('Historical document attachment journal differs');
 const doc=source.document,company=ctx.principal.companyId,user=ctx.principal.personId,ar=source.kind==='customer_invoice';
 if(doc.invoiceNumber.length>50)throw new Error('Historical invoice number exceeds supported document bound');
 const existing=ar?await ctx.sql`SELECT *,invoice_date::text,due_date::text FROM customer_invoices WHERE company_id=${company}::uuid
  AND COALESCE(client_id,customer_id)=${doc.partyId}::uuid AND invoice_number=${doc.invoiceNumber} FOR UPDATE`
  :await ctx.sql`SELECT *,invoice_date::text,due_date::text FROM supplier_invoices WHERE company_id=${company}::uuid
  AND supplier_id=${doc.partyId}::uuid AND invoice_number=${doc.invoiceNumber} FOR UPDATE`;
 if(existing.length>1)throw new Error('Historical invoice identity is ambiguous');
 const before=existing[0] as Row|undefined;
 if(before&&(source.mode!=='attach_subledger'||before.status==='cancelled'||before.invoice_date!==source.accountingDate||before.due_date!==doc.dueDate
  ||before.currency_code!=='ZAR'||(!ar&&before.currency!=='ZAR')||before.gl_journal_entry_id!==null&&before.gl_journal_entry_id!==journalId
  ||!new D(String(before.subtotal)).eq(doc.subtotal)||!new D(String(before.tax_amount)).eq(doc.taxAmount)||!new D(String(before.total_amount)).eq(doc.totalAmount)))throw new Error('Existing historical invoice differs from evidence');
 const linked=ar?await ctx.sql`SELECT id FROM customer_invoices WHERE company_id=${company}::uuid AND gl_journal_entry_id=${journalId}::uuid FOR UPDATE`
  :await ctx.sql`SELECT id FROM supplier_invoices WHERE company_id=${company}::uuid AND gl_journal_entry_id=${journalId}::uuid FOR UPDATE`;
 if(linked.some(row=>(row as Row).id!==before?.id))throw new Error('Historical journal already belongs to another document');
 const id=before?String(before.id):randomUUID(),paid=new D(doc.amountPaid),status=paid.eq(doc.totalAmount)?'paid':paid.gt(0)?'partially_paid':'approved';
 const balance=new D(doc.totalAmount).sub(paid).toFixed(),notes=`Historical source summary: ${source.sourceSystem}/${source.sourceKey}. Exact accounting evidence is linked by import ${ref.entityId}.`;
 if(!before){
  if(ar)await ctx.sql`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,
    amount_paid,status,currency_code,exchange_rate,functional_total,gl_journal_entry_id,created_by,internal_notes)
   VALUES(${id}::uuid,${company}::uuid,${doc.partyId}::uuid,${doc.partyId}::uuid,${doc.invoiceNumber},${source.accountingDate}::date,${doc.dueDate}::date,
    ${doc.subtotal},NULL,${doc.taxAmount},${doc.totalAmount},${doc.amountPaid},${status},'ZAR',1,${doc.totalAmount},${journalId}::uuid,${user},${notes})`;
  else await ctx.sql`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,
    amount_paid,balance_due,status,currency,currency_code,exchange_rate,functional_total,gl_journal_entry_id,created_by,notes)
   VALUES(${id}::uuid,${company}::uuid,${doc.partyId}::uuid,${doc.invoiceNumber},${source.accountingDate}::date,${doc.dueDate}::date,${doc.subtotal},NULL,${doc.taxAmount},${doc.totalAmount},
    ${doc.amountPaid},${balance},${status},'ZAR','ZAR',1,${doc.totalAmount},${journalId}::uuid,${user}::uuid,${notes})`;
 }else if(ar)await ctx.sql`UPDATE customer_invoices SET gl_journal_entry_id=${journalId}::uuid,amount_paid=${doc.amountPaid},status=${status},updated_at=clock_timestamp()
  WHERE company_id=${company}::uuid AND id=${id}::uuid`;
 else await ctx.sql`UPDATE supplier_invoices SET gl_journal_entry_id=${journalId}::uuid,amount_paid=${doc.amountPaid},balance_due=${balance},status=${status},updated_at=clock_timestamp()
  WHERE company_id=${company}::uuid AND id=${id}::uuid`;
 const rows=ar?await ctx.sql`SELECT * FROM customer_invoices WHERE company_id=${company}::uuid AND id=${id}::uuid`
  :await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${id}::uuid`;
 if(rows.length!==1)throw new Error('Historical invoice disappeared');
 const entityType=ar?'customer_invoice':'supplier_invoice',prior=await readControlEntityVersion(ctx,{entityType,entityId:id});
 await recordCommittedChange(ctx,{entityType,entityId:id,previousVersion:prior?.version??null,newVersion:(prior?.version??0)+1,
  action:'historical_import.document_linked',accountingDate:source.accountingDate,before:before??null,after:rows[0] as Row,bindingHash:null,protectedEvidenceRef:null,operationId:permit.operationId});
 return id;
}
