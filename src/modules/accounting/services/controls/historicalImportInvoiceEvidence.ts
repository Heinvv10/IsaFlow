import {importMoney} from './historicalImportExactPlan';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {canonicalJson,canonicalMoney} from './canonical';
import {decodeHistoricalImportSource,historicalHash} from './historicalImportSourceService';
import {openProtectedChange,type ProtectedChange} from './changeProtection';
import type {ControlTx} from './contracts';
type Row=Record<string,unknown>;
export interface HistoricalInvoiceSummary {subtotal:string;taxAmount:string;totalAmount:string;currency:'ZAR';accountingDate:string;importId:string;sourceId:string;journalEntryId:string}
/** Ordinary invoice operations may use verified archival totals without access to raw import artifacts. */
export async function historicalImportInvoiceEvidence(ctx:ControlTx,kind:'customer_invoice'|'supplier_invoice',invoiceId:string):Promise<HistoricalInvoiceSummary|null>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');
 if(!UUID_RE.test(invoiceId)||!['customer_invoice','supplier_invoice'].includes(kind))throw new Error('Invalid historical invoice evidence identity');
 const company=ctx.principal.companyId;
 const receipts=await ctx.sql`SELECT e.result,(to_jsonb(i)||jsonb_build_object('amount',i.amount::text,'accounting_date',i.accounting_date::text)) AS intent,to_jsonb(s) AS source FROM control_operation_effects e
  JOIN control_historical_imports i ON i.company_id=e.company_id AND i.id::text=e.entity_id AND e.result->>'importId'=i.id::text
  JOIN control_historical_import_sources s ON s.company_id=i.company_id AND s.id=i.source_id
  WHERE e.company_id=${company}::uuid AND e.entity_type='historical_import' AND e.operation='historical_import.post'
   AND e.result->>'documentId'=${invoiceId} AND e.result->>'kind'=${kind} LIMIT 2` as {result:Row;intent:Row;source:Row}[];
 if(!receipts.length)return null;
 if(receipts.length!==1)throw new Error('Historical invoice evidence association is ambiguous');
 const receipt=receipts[0]!,intent=receipt.intent,result=receipt.result,artifact=decodeHistoricalImportSource(ctx,receipt.source),source=artifact.normalized,doc=source.document;
 const body=openProtectedChange(intent.payload_envelope as ProtectedChange).after;
 if(!body||!doc||source.kind!==kind||intent.kind!==kind||body.companyId!==company||body.importId!==intent.id||body.sourceId!==artifact.sourceId
  ||body.requesterPersonId!==intent.requester_person_id||body.requesterAuthMethod!==intent.requester_auth_method||body.requesterGrantId!==intent.requester_grant_id
  ||canonicalJson(body.requesterGrantedScopes)!==canonicalJson(intent.requester_granted_scopes)||historicalHash(canonicalJson(body))!==intent.payload_hash
  ||body.contentHash!==artifact.contentHash||body.normalizedHash!==artifact.normalizedHash||canonicalJson(body.normalized)!==canonicalJson(source)
  ||intent.source_system!==source.sourceSystem||intent.source_key!==source.sourceKey||intent.mode!==source.mode||intent.accounting_date!==source.accountingDate
  ||intent.currency!==source.currency||importMoney(intent.amount)!==source.amount||result.mode!==source.mode||result.amount!==source.amount||result.currency!=='ZAR'||result.accountingDate!==source.accountingDate
  ||typeof result.journalEntryId!=='string'||!UUID_RE.test(result.journalEntryId)||!Array.isArray(body.resolvedPlan))throw new Error('Historical invoice protected evidence changed');
 const invoices=kind==='customer_invoice'?await ctx.sql`SELECT id,COALESCE(client_id,customer_id) AS party_id,invoice_number,invoice_date::text,due_date::text,
  subtotal::text,tax_amount::text,total_amount::text,currency_code,exchange_rate::text,gl_journal_entry_id FROM customer_invoices
  WHERE company_id=${company}::uuid AND id=${invoiceId}::uuid FOR SHARE`
  :await ctx.sql`SELECT id,supplier_id AS party_id,invoice_number,invoice_date::text,due_date::text,subtotal::text,tax_amount::text,total_amount::text,
   currency,currency_code,exchange_rate::text,gl_journal_entry_id FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${invoiceId}::uuid FOR SHARE`;
 const invoice=invoices[0] as Row|undefined;
 if(!invoice||invoices.length!==1||invoice.party_id!==doc.partyId||invoice.invoice_number!==doc.invoiceNumber||invoice.invoice_date!==source.accountingDate
  ||(kind==='supplier_invoice'&&invoice.currency!=='ZAR')||invoice.due_date!==doc.dueDate||invoice.gl_journal_entry_id!==result.journalEntryId||invoice.currency_code!=='ZAR'||canonicalMoney(String(invoice.exchange_rate))!=='1'
  ||canonicalMoney(String(invoice.subtotal))!==doc.subtotal||canonicalMoney(String(invoice.tax_amount))!==doc.taxAmount||canonicalMoney(String(invoice.total_amount))!==doc.totalAmount)throw new Error('Historical invoice header differs from source summary');
 const journals=await ctx.sql`SELECT id,status,entry_date::text,source,source_record_id,source_document_hash FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${result.journalEntryId}::uuid FOR SHARE` as Row[];
 const journal=journals[0];
 if(journals.length!==1||!journal||journal.status!=='posted'||journal.entry_date!==source.accountingDate
  ||(source.mode==='post_journal'?(journal.source!=='auto_gl_import'||journal.source_record_id!==intent.id||journal.source_document_hash!==artifact.contentHash):source.existingJournalId!==journal.id))throw new Error('Historical invoice journal evidence differs');
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,vat_type FROM gl_journal_lines WHERE company_id=${company}::uuid
  AND journal_entry_id=${result.journalEntryId}::uuid ORDER BY id LIMIT 1001 FOR SHARE` as Row[];
 const shape=(id:unknown,debit:unknown,credit:unknown,vat:unknown)=>canonicalJson({id,debit:canonicalMoney(String(debit)),credit:canonicalMoney(String(credit)),vat:vat??null});
 const expected=(body.resolvedPlan as Row[]).map(row=>shape(row.glAccountId,row.debit,row.credit,row.vatType)).sort();
 if(canonicalJson(lines.map(row=>shape(row.gl_account_id,row.debit,row.credit,row.vat_type)).sort())!==canonicalJson(expected))throw new Error('Historical invoice ledger differs from exact source plan');
 return{subtotal:doc.subtotal,taxAmount:doc.taxAmount,totalAmount:doc.totalAmount,currency:'ZAR',accountingDate:source.accountingDate,
  importId:String(intent.id),sourceId:artifact.sourceId,journalEntryId:result.journalEntryId};
}
