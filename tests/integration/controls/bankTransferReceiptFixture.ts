import {randomUUID} from 'node:crypto';
import type {transferFixture} from './bankTransferSourcesFixture';
import {recordCommittedChange} from '@/modules/accounting/services/controls/changeEventService';
/** Actual immutable storage fixture, not a claim that the new transfer producer ran. */
export async function seedTransferReceipt(f:Awaited<ReturnType<typeof transferFixture>>,bankId:string,withIntent=true){
 const row=(await f.pool.query('SELECT * FROM bank_transactions WHERE company_id=$1 AND id=$2',[f.f.companyA,bankId])).rows[0];
 const other=row.bank_account_id===f.from?f.to:f.from,journal=randomUUID(),fromLine=randomUUID(),toLine=randomUUID();
 await f.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,description,source,source_record_id,status,created_by) VALUES($1,$2,$3,'Synthetic transfer receipt','auto_bank_transfer',$4,'posted',$5)",[journal,f.f.companyA,row.transaction_date,bankId,f.f.u1.id]);
 const amount=String(row.amount),spent=Number(amount)<0;
 await f.pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,CASE WHEN $5::numeric>0 THEN $5::numeric ELSE 0 END,CASE WHEN $5::numeric<0 THEN -$5::numeric ELSE 0 END)',[fromLine,f.f.companyA,journal,row.bank_account_id,amount]);
 await f.pool.query('INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$4,CASE WHEN $5::numeric<0 THEN -$5::numeric ELSE 0 END,CASE WHEN $5::numeric>0 THEN $5::numeric ELSE 0 END)',[toLine,f.f.companyA,journal,other,amount]);
 await f.pool.query("UPDATE bank_transactions SET status='allocated',matched_journal_line_id=$3,counterparty_account_id=$4,transfer_journal_entry_id=$5,allocation_type='transfer' WHERE company_id=$1 AND id=$2",[f.f.companyA,bankId,fromLine,other,journal]);
 let intentId:string|null=null;
 if(withIntent){
  intentId=await f.intent(bankId,other);const binding='b'.repeat(64);
  const operation=await f.actor(async ctx=>{await recordCommittedChange(ctx,{entityType:'bank_allocation_intent',entityId:intentId!,previousVersion:null,newVersion:1,action:'bank_allocation.post',
   accountingDate:'2026-09-09',before:null,after:{journalEntryId:journal},bindingHash:binding,protectedEvidenceRef:null});return ctx.principal.operationId;});
  const result={intentId,bankTransactionId:bankId,journalEntryId:journal,paymentId:null,oppositeBankTransactionId:null,afterFingerprint:'c'.repeat(64),status:'allocated'};
  await f.pool.query("INSERT INTO control_operation_effects(company_id,operation_id,operation,entity_type,entity_id,binding_hash,result) VALUES($1,$2,'bank_allocation.post','bank_allocation_intent',$3,$4,$5)",[f.f.companyA,operation,intentId,binding,result]);
 }
 return{journal,fromLine,toLine,intentId,spent};
}
