import {randomUUID} from 'node:crypto';
import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {postJournalEntry} from '../gl/journalEntryPostingService';
import {loadBankAllocationIntent} from './bankAllocationMaterial';
import {loadBankAllocationSources} from './bankAllocationSources';
import {applyBankAllocationChildren,recordBankAllocationChild} from './bankAllocationChildEffect';
export async function executeBankAllocationEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit){
 const parent={entityType:'bank_allocation_intent',entityId:intentId,operation:'bank_allocation.post' as const};
 assertControlledEffectPermit(ctx,permit,parent);
 const {intent,plan,sources,effect}=await loadBankAllocationIntent(ctx,intentId);
 if(effect||sources.bank.status!=='imported')throw new Error('Bank allocation already executed');
 if(sources.periods[0]!.status!=='open')throw new Error('Open bank accounting period required');
 const company=ctx.principal.companyId,id=randomUUID();
 const source=plan.kind==='customer'?'auto_payment':plan.kind==='supplier'?'auto_supplier_payment':'auto_bank_recon';
 await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,source_record_id,status,created_by,posting_agent)
  VALUES(${id}::uuid,${company}::uuid,${permit.accountingDate}::date,${sources.periods[0]!.id}::uuid,${plan.description??'Bank allocation'},${source},${plan.bankTransactionId}::uuid,'draft',${ctx.principal.personId}::uuid,${`human:${ctx.principal.personId}`})`;
 for(const line of sources.lines)await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description,vat_type,cost_center_id,bu_id)
  VALUES(${company}::uuid,${id}::uuid,${line.accountId}::uuid,${line.debit}::numeric,${line.credit}::numeric,${line.description},${line.vatType},${line.cc1Id}::uuid,${line.buId}::uuid)`;
 const parentControl={parent,permit};await registerGeneratedJournal(ctx,parentControl,id,'journal.post');
 await postJournalEntry(company,id,ctx.principal.personId,{parentControl});
 const paymentId=await applyBankAllocationChildren(ctx,permit,plan,id,intent.amount);
 const bankLines=await ctx.sql`SELECT id FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${id}::uuid AND gl_account_id=${sources.bank.bank_account_id}::uuid` as {id:string}[];
 if(bankLines.length!==1)throw new Error('Allocation bank journal line is ambiguous');
 const [after]=await ctx.sql`UPDATE bank_transactions SET status='allocated',matched_journal_line_id=${bankLines[0]!.id}::uuid,
  allocation_type=${plan.kind==='split'?'account':plan.kind},allocated_entity_name=${sources.party?String(sources.party.name):'Account allocation'},
  allocation_rule_id=NULL,allocation_rule_name=NULL,allocation_batch_id=NULL,updated_at=clock_timestamp()
  WHERE company_id=${company}::uuid AND id=${plan.bankTransactionId}::uuid AND status='imported' RETURNING *` as Record<string,unknown>[];
 if(!after)throw new Error('Bank allocation state changed');
 await recordBankAllocationChild(ctx,permit,'bank_transaction',sources.bank,after,'bank_allocation.posted');
 const observed=await loadBankAllocationSources(ctx,plan);
 return{intentId,bankTransactionId:plan.bankTransactionId,journalEntryId:id,paymentId,afterFingerprint:observed.fingerprint,status:'allocated' as const};
}
