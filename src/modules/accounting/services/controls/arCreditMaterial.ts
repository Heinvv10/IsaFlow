import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {assertControlTx} from './context';
import type {ControlTx,OperationRef} from './contracts';
import type {ApMaterial,ObservedSource} from './apOperationMaterializer';
import {resolveArAccounts} from './arControlAccounts';
import {deriveArCreditMoney} from './arExactMaterial';
import {materializeGlOperation} from './glOperationMaterializer';
import {observeArSource} from './arOperationMaterializer';
import {lockArInvoiceSources,type ArRow} from './arSourceMaterial';
const Money=Decimal.clone({precision:80});
export async function lockArCreditSources(ctx:ControlTx,id:string){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${company}`},0))`;
 const [header]=await ctx.sql`SELECT * FROM credit_notes WHERE company_id=${company}::uuid AND id=${id}::uuid FOR UPDATE` as ArRow[];
 if(!header||!['customer','supplier'].includes(String(header.type)))throw new Error('Credit note not found');
 const supplier=header.type==='supplier',partyId=supplier?header.supplier_id:header.client_id;
 const party=supplier?await ctx.sql`SELECT id FROM suppliers WHERE company_id=${company}::uuid AND id=${String(partyId)}::uuid FOR SHARE`:
 await ctx.sql`SELECT id FROM customers WHERE company_id=${company}::uuid AND id=${String(partyId)}::uuid FOR SHARE`;
 if(party.length!==1)throw new Error('Credit note counterparty not found');
 let linked:ArRow|null=null;
 if(header.customer_invoice_id||header.supplier_invoice_id){
  const rows=supplier?await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${String(header.supplier_invoice_id)}::uuid
   AND supplier_id=${String(header.supplier_id)}::uuid FOR UPDATE`:
   await ctx.sql`SELECT * FROM customer_invoices WHERE company_id=${company}::uuid AND id=${String(header.customer_invoice_id)}::uuid
   AND COALESCE(client_id,customer_id)=${String(header.client_id)}::uuid FOR UPDATE`;
  if(rows.length!==1)throw new Error('Credit note linked invoice not found');linked=rows[0] as ArRow;
 }
 return{header,linked};
}
export async function materializeArCreditOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 const application=ref.entityType==='credit_note_application',company=ctx.principal.companyId;
 let intent:ArRow|null=null;
 if(application){const rows=await ctx.sql`SELECT * FROM control_credit_note_applications WHERE company_id=${company}::uuid AND id=${ref.entityId}::uuid` as ArRow[];
  if(rows.length!==1)throw new Error('Credit application not found');intent=rows[0]!;}
 const data=await lockArCreditSources(ctx,application?String(intent!.credit_note_id):ref.entityId),{header,linked}=data;
 const reverse=String(ref.operation)==='credit_note.cancel',supplier=header.type==='supplier';
 const accounts=await resolveArAccounts(ctx,reverse||application?[]:supplier?['payable','default_expense','vat_input']:['receivable','default_revenue','vat_output']);
 const money=deriveArCreditMoney(header,linked?(supplier?linked.currency:linked.currency_code):null,accounts.ledgerCurrency);
 let amount=money.amount,accountingDate=fmtDate(header.credit_date);
 const facts:Record<string,unknown>={...data,accounts:accounts.facts};const observed:ObservedSource[]=[];
 const addSources=(sources:ObservedSource[])=>{for(const source of sources){
  const prior=observed.find(existing=>existing.entityType===source.entityType&&existing.entityId===source.entityId);
  if(prior&&prior.fingerprint!==source.fingerprint)throw new Error('Conflicting credit source observation');
  if(!prior)observed.push(source);
 }};
 const bindTargetJournal=async(invoice:ArRow,key:string)=>{
  if(!invoice.gl_journal_entry_id)return;
  const journal=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(invoice.gl_journal_entry_id),operation:'journal.post'});
  facts[key]=journal.observedSources[0]!.facts;
  addSources(journal.observedSources);
 };
 if(linked)await bindTargetJournal(linked,'linkedInvoiceJournal');
 if(application){
  const target=await lockArInvoiceSources(ctx,String(intent!.customer_invoice_id));
  if(header.type!=='customer'||target.header.owned_customer_id!==header.client_id||target.header.currency_code!==money.currency)throw new Error('Credit application target does not match');
  const available=Money.max(0,new Money(String(target.header.total_amount)).sub(String(target.header.amount_paid??'0')));
  // Already-applied material preserves the immutable applied amount for after-effect evidence.
  amount=(header.status==='applied'&&header.customer_invoice_id===intent!.customer_invoice_id?new Money(String(header.applied_amount)):Money.min(amount,available)).toFixed();
  facts.intent=intent;facts.target=target;observed.push(await observeArSource(ctx,'credit_note',String(header.id),data),await observeArSource(ctx,'customer_invoice',String(intent!.customer_invoice_id),target));
  await bindTargetJournal(target.header,'targetInvoiceJournal');
 }
 if(header.gl_journal_entry_id){const journal=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(header.gl_journal_entry_id),operation:reverse?'journal.reverse':'journal.post',
  ...(ref.reversalDate===undefined?{}:{reversalDate:ref.reversalDate})});facts.journal=journal.observedSources[0]!.facts;addSources(journal.observedSources);if(reverse)accountingDate=journal.binding.accountingDate!;}
 const periods=await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods WHERE company_id=${company}::uuid
 AND start_date<=${accountingDate}::date AND end_date>=${accountingDate}::date ORDER BY id FOR SHARE` as ArRow[];
 if(periods.length!==1)throw new Error('Credit note target period is missing or ambiguous');facts.targetPeriod=periods[0]!;facts.accountingDate=accountingDate;
 const parent=await observeArSource(ctx,ref.entityType,ref.entityId,facts);observed.unshift(parent);
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('AR source version changed');
 return{supplierId:supplier?String(header.supplier_id):'',observedSources:observed,versionBasis:observed.every(s=>s.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
 binding:{companyId:company,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,accountingDate,amount,currency:money.currency,
 beneficiaries:[],sourceVersions:observed.map(({facts:_facts,tracked:_tracked,...s})=>s)}};
}
