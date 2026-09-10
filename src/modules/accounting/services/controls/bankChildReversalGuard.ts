import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
/** A bank receipt/payment is reversed with its bank parent so both ledgers and allocation agree. */
export async function assertStandaloneBankChildReversal(ctx:ControlTx,paymentId:string,journalId:unknown):Promise<void>{
 assertControlTx(ctx);
 // Both AR/AP materializers call this during approval preparation and again at execution.
 // A single-payment approval cannot authorize reversing cash owned by another live child.
 if(journalId){
  const siblings=await ctx.sql`SELECT id FROM (
   SELECT id FROM customer_payments WHERE company_id=${ctx.principal.companyId}::uuid
    AND gl_journal_entry_id=${journalId}::uuid AND status<>'cancelled'
   UNION ALL
   SELECT id FROM supplier_payments WHERE company_id=${ctx.principal.companyId}::uuid
    AND gl_journal_entry_id=${journalId}::uuid AND status<>'cancelled'
  ) children LIMIT 2`;
  if(siblings.length>1)throw new Error('Shared payment journal requires an explicit aggregate inverse');
 }
 const [origin]=await ctx.sql`SELECT 1 AS bank_owned WHERE EXISTS(
  SELECT 1 FROM control_operation_effects e
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.operation='bank_allocation.post'
   AND e.entity_type='bank_allocation_intent' AND e.result->>'paymentId'=${paymentId}
 ) OR EXISTS(
  SELECT 1 FROM bank_transactions b JOIN gl_journal_lines l
   ON l.company_id=b.company_id AND l.id=b.matched_journal_line_id
  WHERE b.company_id=${ctx.principal.companyId}::uuid AND l.journal_entry_id=${journalId??null}::uuid
 )`;
 if(origin)throw new Error('Bank-created payment requires its bank allocation reversal');
}

/** A document-addressed bank inverse must name the actual child of its persisted original effect. */
export async function assertBankPaymentInverseIdentity(ctx:ControlTx,kind:'customer'|'supplier',paymentId:string,
 bankTransactionId:string,journalId:string):Promise<void>{
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const payments=kind==='customer'?await ctx.sql`SELECT id FROM customer_payments WHERE company_id=${company}::uuid
  AND id=${paymentId}::uuid AND gl_journal_entry_id=${journalId}::uuid FOR SHARE`
  :await ctx.sql`SELECT id FROM supplier_payments WHERE company_id=${company}::uuid
   AND id=${paymentId}::uuid AND gl_journal_entry_id=${journalId}::uuid FOR SHARE`;
 const receipts=await ctx.sql`SELECT e.id FROM control_bank_allocation_intents i
  JOIN control_operation_effects e ON e.company_id=i.company_id AND e.entity_type='bank_allocation_intent'
   AND lower(e.entity_id)=i.id::text AND e.operation='bank_allocation.post'
  JOIN bank_transactions b ON b.company_id=i.company_id AND b.id=i.bank_transaction_id
  JOIN gl_journal_lines l ON l.company_id=b.company_id AND l.id=b.matched_journal_line_id
  JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id
  WHERE i.company_id=${company}::uuid AND b.id=${bankTransactionId}::uuid
   AND j.id=${journalId}::uuid AND j.source_record_id=b.id AND l.gl_account_id=b.bank_account_id
   AND i.payload->>'kind'=${kind} AND i.payload->>'bankTransactionId'=b.id::text
   AND lower(e.result->>'intentId')=i.id::text AND e.result->>'bankTransactionId'=b.id::text
   AND e.result->>'journalEntryId'=j.id::text AND e.result->>'paymentId'=${paymentId}
  LIMIT 2 FOR SHARE OF b,l,j`;
 if(payments.length!==1||receipts.length!==1)throw new Error('Original bank allocation payment identity does not match requested document');
}
