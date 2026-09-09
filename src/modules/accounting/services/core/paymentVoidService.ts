/** Payment-addressed inverse adapter. All economic writes belong to approved domain services. */
import {sql,withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {lockCustomerPaymentForUpdate,lockSupplierPaymentForUpdate} from './paymentLock';
import {reverseReconciledTransaction} from '../bank/bankAllocationService';
import {cancelCustomerPayment} from '../ar/customerPaymentAllocationService';
import {voidSupplierPayment} from '../ap/supplierPaymentWorkflowService';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
export type PaymentKind = 'customer' | 'supplier';

export interface VoidPaymentResult {
  paymentId: string;
  paymentNumber: string | null;
  kind: PaymentKind;
  /** Invoices whose `amount_paid` was reduced. */
  invoicesReopened: number;
  /** Total taken back off those invoices. */
  amountUnapplied: number;
  /** The journal that was reversed, when there was one. */
  journalEntryId: string | null;
  /** The bank line returned to `imported`, when the payment settled one. */
  bankTransactionId: string | null;
}

/** Why a void was refused. Distinguished so the caller can word each one. */
export type VoidRefusal =
  | { refusal: 'not_found' }
  | { refusal: 'already_cancelled' }
  | { refusal: 'not_applied'; status: string }
  | { refusal: 'ambiguous_bank_lines'; count: number };

export function isVoidRefusal(v: VoidPaymentResult | VoidRefusal): v is VoidRefusal {
  return 'refusal' in v;
}

interface PaymentRow {
  id: string;
  paymentNumber: string | null;
  status: string;
  journalEntryId: string | null;
}


export interface VoidPaymentOptions extends PostingActorOpts {intentId?:string;approvalId?:string;reversalDate?:string;reason?:string}
/** Owned active allocations describe this operation's result; historical inverse rows never count twice. */
async function applicationTotals(companyId:string,kind:PaymentKind,paymentId:string){
 const rows=kind==='customer'?await sql`SELECT count(DISTINCT a.invoice_id)::int AS count,COALESCE(sum(a.amount_allocated),0)::text AS amount
  FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
  WHERE p.company_id=${companyId}::uuid AND p.id=${paymentId}::uuid AND a.reversed_at IS NULL`
  :await sql`SELECT count(DISTINCT a.invoice_id)::int AS count,COALESCE(sum(a.amount_allocated),0)::text AS amount
  FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id
  WHERE p.company_id=${companyId}::uuid AND p.id=${paymentId}::uuid AND a.reversed_at IS NULL`;
 const row=rows[0] as {count:number;amount:string};return{invoicesReopened:row.count,amountUnapplied:Number(row.amount)};
}
export async function voidPaymentDocument(companyId:string,kind:PaymentKind,paymentId:string,userId:string,
 opts?:VoidPaymentOptions):Promise<VoidPaymentResult|VoidRefusal>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Control transaction actor does not match payment void');
 await assertEffectivePermission(ctx,'write:invoices');await assertEffectivePermission(ctx,'write:post');
 return withSavepoint('payment_document_void',async()=>{
  const row=kind==='customer'?await lockCustomerPaymentForUpdate(companyId,paymentId):await lockSupplierPaymentForUpdate(companyId,paymentId);
  if(!row)return{refusal:'not_found'};
  const payment:PaymentRow={id:String(row.id),paymentNumber:row.payment_number==null?null:String(row.payment_number),status:String(row.status),journalEntryId:row.gl_journal_entry_id==null?null:String(row.gl_journal_entry_id)};
  if(payment.status==='cancelled')return{refusal:'already_cancelled'};
  if(!(kind==='customer'?['confirmed','reconciled']:['processed','reconciled']).includes(payment.status))return{refusal:'not_applied',status:payment.status};
  const bankLines=payment.journalEntryId?await sql`SELECT bt.id FROM bank_transactions bt
   JOIN gl_journal_lines jl ON jl.id=bt.matched_journal_line_id AND jl.company_id=bt.company_id
   WHERE bt.company_id=${companyId}::uuid AND jl.journal_entry_id=${payment.journalEntryId}::uuid
    AND bt.status IN ('allocated','matched','reconciled') ORDER BY bt.transaction_date,bt.id` as {id:string}[]:[];
  if(bankLines.length>1)return{refusal:'ambiguous_bank_lines',count:bankLines.length};
  const bankTransactionId=bankLines[0]?.id??null;
  if(bankTransactionId){
   const result=await reverseReconciledTransaction(companyId,bankTransactionId,userId,opts);
   return{paymentId:payment.id,paymentNumber:payment.paymentNumber,kind,invoicesReopened:result.invoicesReopened,
    amountUnapplied:result.amountUnapplied,journalEntryId:payment.journalEntryId,bankTransactionId};
  }
  const totals=await applicationTotals(companyId,kind,payment.id);
  if(kind==='customer')await cancelCustomerPayment(companyId,payment.id,userId,opts?.reason,opts);
  else await voidSupplierPayment(companyId,payment.id,userId,opts);
  return{paymentId:payment.id,paymentNumber:payment.paymentNumber,kind,...totals,journalEntryId:payment.journalEntryId,bankTransactionId:null};
 });
}
