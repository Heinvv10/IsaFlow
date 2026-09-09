import {randomUUID} from 'node:crypto';
import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {matchesBankAllocationJournalLines} from '../controls/bankAllocationJournalShape';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {postJournalEntry} from '../gl/journalEntryPostingService';
import {bankAllocationActor} from './bankAllocationActor';
import {loadBankAllocationIntent} from './bankAllocationMaterial';
import {loadBankAllocationSources} from './bankAllocationSources';
import {recordBankAllocationChild} from './bankAllocationChildEffect';
type Row=Record<string,unknown>;
/** A saved transfer either posts exactly two bank legs or links the saved original; never both. */
export async function executeBankTransferEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit,options?:PostingActorOpts){
 const parent={entityType:'bank_allocation_intent',entityId:intentId,operation:'bank_allocation.post' as const};
 assertControlledEffectPermit(ctx,permit,parent);
 const {plan,sources,effect}=await loadBankAllocationIntent(ctx,intentId);
 if(plan.kind!=='transfer'||!sources.transfer||effect||sources.bank.status!=='imported')throw new Error('Unexecuted saved transfer required');
 if(sources.periods.length!==1||sources.periods[0]!.status!=='open')throw new Error('Open transfer accounting period required');
 const company=ctx.principal.companyId,state=sources.transfer,actor=bankAllocationActor(ctx.principal,options);
 let journalId:string;
 if(plan.transfer.mode==='post'){
  journalId=randomUUID();
  await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,posting_agent,actor_type,actor_token_jti)
   VALUES(${journalId}::uuid,${company}::uuid,${permit.accountingDate}::date,${sources.periods[0]!.id}::uuid,${plan.description??'Bank transfer'},'auto_bank_transfer',
    ${plan.bankTransactionId}::uuid,'draft',${ctx.principal.personId}::uuid,${actor.postingAgent},${actor.actorType},${actor.actorTokenJti})`;
  for(const line of sources.lines)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
   VALUES(${company}::uuid,${journalId}::uuid,${line.accountId}::uuid,${line.debit}::numeric,${line.credit}::numeric,${line.description})`;
  const parentControl={parent,permit};await registerGeneratedJournal(ctx,parentControl,journalId,'journal.post');
  await postJournalEntry(company,journalId,ctx.principal.personId,{parentControl});
 }else{
  if(!state.original||state.original.originalIntentId!==plan.transfer.originalIntentId)throw new Error('Saved original transfer unavailable');
  journalId=String(state.original.journal.id);
 }
 const lines=await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id FROM gl_journal_lines
  WHERE company_id=${company}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE` as (Row&Parameters<typeof matchesBankAllocationJournalLines>[1][number])[];
 if(!matchesBankAllocationJournalLines(sources.lines,lines))throw new Error('Transfer journal economics changed');
 async function link(before:Row,counterpartyAccountId:string,name:string){
  const matching=lines.filter(line=>line.gl_account_id===before.bank_account_id);
  if(matching.length!==1)throw new Error('Transfer journal bank line is ambiguous');
  const occupied=await ctx.sql`SELECT id FROM bank_transactions WHERE company_id=${company}::uuid AND matched_journal_line_id=${matching[0]!.id}::uuid LIMIT 1`;
  if(occupied.length)throw new Error('Transfer journal bank line already occupied');
  const [after]=await ctx.sql`UPDATE bank_transactions SET status='allocated',matched_journal_line_id=${matching[0]!.id}::uuid,
   allocation_type='transfer',counterparty_account_id=${counterpartyAccountId}::uuid,transfer_journal_entry_id=${journalId}::uuid,allocated_entity_name=${name},
   allocation_rule_id=NULL,allocation_rule_name=NULL,allocation_batch_id=NULL,cc1_id=NULL,cc2_id=NULL,bu_id=NULL,updated_at=clock_timestamp()
   WHERE company_id=${company}::uuid AND id=${before.id}::uuid AND status='imported' AND matched_journal_line_id IS NULL RETURNING *` as Row[];
  if(!after)throw new Error('Transfer bank state changed');
  await recordBankAllocationChild(ctx,permit,'bank_transaction',before,after,'bank_allocation.posted');
 }
 await link(sources.bank,plan.counterpartyAccountId,String(state.counterpartyAccount.account_name));
 if(plan.transfer.mode==='post'&&plan.transfer.oppositeBankTransactionId){
  if(!state.oppositeBank||state.oppositeBank.id!==plan.transfer.oppositeBankTransactionId)throw new Error('Saved opposite transfer source unavailable');
  await link(state.oppositeBank,String(sources.bank.bank_account_id),String(state.sourceAccount.account_name));
 }
 const observed=await loadBankAllocationSources(ctx,plan,{postExecution:true});
 return{intentId,bankTransactionId:plan.bankTransactionId,journalEntryId:journalId,paymentId:null,
  oppositeBankTransactionId:plan.transfer.mode==='post'?plan.transfer.oppositeBankTransactionId:String(state.original!.originalBank.id),
  ...(plan.transfer.mode==='link'?{originalIntentId:plan.transfer.originalIntentId}:{}),afterFingerprint:observed.fingerprint,status:'allocated' as const};
}
