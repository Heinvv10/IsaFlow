import {expect,it} from 'vitest';
import {proveBankTransferCandidate} from '@/modules/accounting/services/bank/bankTransferCandidateProof';
const bankId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',originalId='33333333-3333-4333-8333-333333333333';
const journalId='44444444-4444-4444-8444-444444444444',intentId='55555555-5555-4555-8555-555555555555',sourceId='66666666-6666-4666-8666-666666666666';
function facts(){return{bank:{id:bankId,bank_account_id:sourceId,amount:'115.23',transaction_date:'2026-09-09'},
 counterpartyAccountId:otherId,journal:{id:journalId,source:'auto_bank_transfer',source_record_id:originalId,status:'posted',reversed_at:null,entry_date:'2026-09-08'},
 lines:[{id:'from',gl_account_id:otherId,debit:'0',credit:'115.23'},{id:'to',gl_account_id:sourceId,debit:'115.23',credit:'0'}],
 originalBank:{id:originalId,bank_account_id:otherId,amount:'-115.23',transaction_date:'2026-09-08',status:'allocated',matched_journal_line_id:'from',counterparty_account_id:sourceId,transfer_journal_entry_id:journalId,allocation_type:'transfer'},
 intent:{id:intentId,bank_transaction_id:originalId,accounting_date:'2026-09-08',amount:'115.23',currency:'ZAR',payload:{version:1,kind:'transfer',bankTransactionId:originalId,counterpartyAccountId:sourceId,transfer:{mode:'post',oppositeBankTransactionId:null}}},
 effect:{entity_id:intentId,entity_type:'bank_allocation_intent',operation:'bank_allocation.post',operation_id:'operation',binding_hash:'binding',result:{intentId,bankTransactionId:originalId,journalEntryId:journalId,paymentId:null,oppositeBankTransactionId:null,status:'allocated'}},
 events:[{entity_id:intentId,entity_type:'bank_allocation_intent',action:'bank_allocation.post',operation_id:'operation',binding_hash:'binding'}],occupied:false};}
it('proves exact original signed transfer and its unused destination leg',()=>{expect(proveBankTransferCandidate(facts())).toMatchObject({destinationLineId:'to',originalIntentId:intentId});});
it.each(['extra leg','occupied','missing event','wrong amount','wrong match','legacy','link intent','opposite already bound'])('refuses %s transfer provenance',which=>{
 const f=facts();
 if(which==='extra leg')f.lines.push({...f.lines[0]!,id:'extra'});
 if(which==='occupied')f.occupied=true;
 if(which==='missing event')f.events=[];
 if(which==='wrong amount')f.originalBank.amount='-100';
 if(which==='wrong match')f.originalBank.matched_journal_line_id='other';
 if(which==='legacy')f.intent=null as never;
 if(which==='link intent')f.intent.payload.transfer.mode='link';
 if(which==='opposite already bound')f.effect.result.oppositeBankTransactionId=bankId as never;
 expect(()=>proveBankTransferCandidate(f)).toThrow();
});
