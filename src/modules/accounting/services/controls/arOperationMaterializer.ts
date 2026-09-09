import {assertStandaloneBankChildReversal} from './bankChildReversalGuard';
import {historicalImportInvoiceEvidence} from './historicalImportInvoiceEvidence';
import {assertCashApplicationsUnapplied} from '../shared/cashApplicationCancellation';
import {createHash} from 'node:crypto';
import {canonicalJson} from './canonical';
import {UUID_RE,isRealCalendarDate} from '@/lib/validation';
import {fmtDate} from '@/lib/fmtDate';
import type {ControlTx,OperationRef} from './contracts';
import type {ApMaterial,ObservedSource} from './apOperationMaterializer';
import {readControlEntityVersion} from './operationVersions';
import {materializeGlOperation} from './glOperationMaterializer';
import {lockArInvoiceSources,lockArPaymentSources,type ArRow} from './arSourceMaterial';
import {deriveArInvoiceMoney,deriveArSettlementMoney} from './arExactMaterial';
import {resolveArAccounts} from './arControlAccounts';
import {materializeArCreditOperation} from './arCreditMaterial';
import {materializeArRecurringOperation} from './arRecurringMaterial';
export async function observeArSource(ctx:ControlTx,entityType:string,entityId:string,facts:Record<string,unknown>):Promise<ObservedSource>{
 const prior=await readControlEntityVersion(ctx,{entityType,entityId});return{entityType,entityId,version:prior?.version??1,tracked:prior!==null,facts,
 fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
}
export async function materializeArOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(!UUID_RE.test(ref.entityId))throw new Error('Invalid AR operation reference');
 if(['credit_note','credit_note_application'].includes(ref.entityType)){
  if(!(ref.entityType==='credit_note'&&['credit_note.approve','credit_note.cancel'].includes(ref.operation))&&!(ref.entityType==='credit_note_application'&&ref.operation==='credit_note_application.apply'))throw new Error('Unsupported AR operation');
  return materializeArCreditOperation(ctx,ref);
 }
 if(ref.entityType==='recurring_invoice_run'){if(ref.operation!=='recurring_invoice.generate')throw new Error('Unsupported AR operation');return materializeArRecurringOperation(ctx,ref);}
 const op=String(ref.operation),invoice=ref.entityType==='customer_invoice';
 if(!(invoice&&['customer_invoice.post','customer_invoice.cancel'].includes(op))&&!(ref.entityType==='customer_payment'&&['customer_payment.confirm','customer_payment.cancel'].includes(op)))throw new Error('Unsupported AR operation');
 const reverse=op.endsWith('.cancel');
 let header:ArRow,source:Record<string,unknown>,amount:string,currency:string,accountingDate:string;
 const observed:ObservedSource[]=[];
 if(invoice){
  const data=await lockArInvoiceSources(ctx,ref.entityId);header=data.header;
  const accounts=await resolveArAccounts(ctx,reverse?[]:['receivable','default_revenue','vat_output']);
  const archivalSummary=data.lines.length?null:await historicalImportInvoiceEvidence(ctx,'customer_invoice',ref.entityId);
  if(archivalSummary){
   if(archivalSummary.currency!==accounts.ledgerCurrency)throw new Error('Historical invoice currency differs from ledger');
   amount=archivalSummary.totalAmount;currency=archivalSummary.currency;
  }else ({amount,currency}=deriveArInvoiceMoney(header,data.lines,accounts.ledgerCurrency));
  source={...data,archivalSummary,accounts:accounts.facts};accountingDate=fmtDate(header.invoice_date);
 }else{
  const data=await lockArPaymentSources(ctx,ref.entityId);header=data.header;
  if(reverse)await assertStandaloneBankChildReversal(ctx,ref.entityId,header.gl_journal_entry_id);
  if(reverse)await assertCashApplicationsUnapplied(ctx,ref.entityId,'customer');
  const explicit=header.bank_account_id?[String(header.bank_account_id)]:[];
  const accounts=await resolveArAccounts(ctx,reverse?[]:explicit.length?['receivable']:['receivable','bank'],reverse?[]:explicit);
  ({amount,currency}=deriveArSettlementMoney(header.total_amount,header.currency_code,data.allocations.filter(a=>a.reversed_at==null).map(a=>({amount:a.amount_allocated,currency:a.invoice_currency})),accounts.ledgerCurrency));
  source={...data,accounts:accounts.facts};accountingDate=fmtDate(header.payment_date);
  for(const invoiceHeader of data.invoices)observed.push(await observeArSource(ctx,'customer_invoice',String(invoiceHeader.id),
   {header:invoiceHeader,lines:data.invoiceLines.filter(line=>line.invoice_id===invoiceHeader.id)}));
 }
 if(!isRealCalendarDate(accountingDate))throw new Error('AR accounting date is invalid');
 if(header.gl_journal_entry_id){
  const journal=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(header.gl_journal_entry_id),operation:reverse?'journal.reverse':'journal.post',
   ...(ref.reversalDate===undefined?{}:{reversalDate:ref.reversalDate})});
  if(reverse)accountingDate=journal.binding.accountingDate!;
  source.journal=journal.observedSources[0]!.facts;observed.push(...journal.observedSources);
 }else if(ref.reversalDate!==undefined&&ref.reversalDate!==accountingDate)throw new Error('No AR journal to reverse');
 const periods=await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods WHERE company_id=${ctx.principal.companyId}::uuid
 AND start_date<=${accountingDate}::date AND end_date>=${accountingDate}::date ORDER BY id FOR SHARE` as ArRow[];
 if(periods.length!==1)throw new Error('AR target fiscal period is missing or ambiguous');
 source.targetPeriod=periods[0]!;source.accountingDate=accountingDate;
 const parent=await observeArSource(ctx,ref.entityType,ref.entityId,source);observed.unshift(parent);
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('AR source version changed');
 return{supplierId:'',observedSources:observed,versionBasis:observed.every(s=>s.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
 binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
 accountingDate,amount,currency,beneficiaries:[],sourceVersions:observed.map(({facts:_facts,tracked:_tracked,...s})=>s)}};
}
