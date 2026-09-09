import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
import {fmtDate} from '@/lib/fmtDate';
import {assertControlTx} from '../controls/context';
import {matchesBankAllocationJournalLines} from '../controls/bankAllocationJournalShape';
import {canonicalJson} from '../controls/canonical';
import type {ControlTx} from '../controls/contracts';
import {parseBankAllocationPlan,isBankAllocationRefund} from './bankAllocationPlan';
import {loadBankAllocationSources} from './bankAllocationSources';
type Row=Record<string,unknown>;
/** Prove original financial facts independently of mutable close-period/approval state. */
export async function loadBankAllocationOriginal(ctx:ControlTx,originalIntentId:string){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,accounting_date::text,amount::text FROM control_bank_allocation_intents WHERE company_id=${company}::uuid AND id=${originalIntentId}::uuid` as Row[];
 if(!intent)throw new Error('Original controlled allocation intent required');
 const plan=parseBankAllocationPlan(intent.payload),sources=await loadBankAllocationSources(ctx,plan);
 const [receipt]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${company}::uuid AND operation='bank_allocation.post'
  AND entity_type='bank_allocation_intent' AND entity_id=${originalIntentId} ORDER BY committed_at DESC LIMIT 1` as {id:string;result:{intentId:string;journalEntryId:string;paymentId:string|null}}[];
 if(!receipt||receipt.result.intentId!==originalIntentId||plan.bankTransactionId!==intent.bank_transaction_id)throw new Error('Original bank allocation receipt required');
 const [journal]=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${receipt.result.journalEntryId}::uuid FOR SHARE` as Row[];
 const lines=await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id FROM gl_journal_lines
  WHERE company_id=${company}::uuid AND journal_entry_id=${receipt.result.journalEntryId}::uuid ORDER BY id FOR SHARE` as (Row&Parameters<typeof matchesBankAllocationJournalLines>[1][number])[];
 if(!new D(String(sources.bank.amount)).abs().eq(String(intent.amount))||fmtDate(sources.bank.transaction_date as string|Date)!==intent.accounting_date)throw new Error('Original bank source changed');
 if(!journal||journal.status!=='posted'||fmtDate(journal.entry_date as string|Date)!==intent.accounting_date||journal.source_record_id!==plan.bankTransactionId
  ||journal.source!==(plan.kind==='customer'?'auto_payment':plan.kind==='supplier'?'auto_supplier_payment':'auto_bank_recon')
  ||!matchesBankAllocationJournalLines(sources.lines,lines))throw new Error('Original allocation journal changed');
 if(isBankAllocationRefund(plan.kind,String(sources.bank.amount))){
  // Prior reversed allocations retain their children; absence belongs to this exact refund journal.
  const currentChildren=[...sources.receipts,...sources.disbursements].filter(p=>p.gl_journal_entry_id===journal.id);
  if(receipt.result.paymentId!==null||currentChildren.length)throw new Error('Refund must not have payment or application children');
 }else if('applications' in plan){
  const payments=plan.kind==='customer'?sources.receipts:sources.disbursements;
  const payment=payments.find(p=>p.id===receipt.result.paymentId);
  if(!payment||payment.gl_journal_entry_id!==journal.id||!new D(String(payment.total_amount)).eq(String(intent.amount))
   ||(plan.kind==='customer'?payment.client_id:payment.supplier_id)!==plan.partyId)throw new Error('Original allocation payment changed');
  const rows=(plan.kind==='customer'?sources.receiptAllocations:sources.paymentAllocations).filter(a=>a.payment_id===payment.id);
  const shape=(id:unknown,amount:unknown)=>canonicalJson({id,amount:new D(String(amount)).toFixed()});
  const expected=plan.applications.map(a=>shape(a.invoiceId,a.amount)).sort(),actual=rows.map(a=>shape(a.invoice_id,a.amount_allocated)).sort();
  if(canonicalJson(expected)!==canonicalJson(actual))throw new Error('Original allocation applications changed');
 }
 return{intent,plan,sources,receipt,journal,lines};
}
export async function assertOriginalAllocationReversible(ctx:ControlTx,originalIntentId:string){
 const material=await loadBankAllocationOriginal(ctx,originalIntentId);
 if(material.journal.reversed_at||!['allocated','matched','reconciled'].includes(String(material.sources.bank.status))
  ||!material.lines.some(l=>l.id===material.sources.bank.matched_journal_line_id&&l.gl_account_id===material.sources.bank.bank_account_id))throw new Error('Original allocation is no longer reversible');
 if('applications' in material.plan&&!isBankAllocationRefund(material.plan.kind,String(material.sources.bank.amount))){
  const payment=(material.plan.kind==='customer'?material.sources.receipts:material.sources.disbursements).find(p=>p.id===material.receipt.result.paymentId)!;
  if(!['confirmed','reconciled','processed'].includes(String(payment.status)))throw new Error('Original payment is not active');
  for(const item of material.sources.invoices){const invoice=item.invoice as Row,allocation=item.allocation as {amount:string};
   if(new D(String(invoice.amount_paid)).lt(allocation.amount))throw new Error('Allocation reversal exceeds invoice paid balance');
  }
 }
 return material;
}
