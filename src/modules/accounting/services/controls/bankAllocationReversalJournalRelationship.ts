import type {ControlTx} from './contracts';
import type {ParentJournalControl} from './generatedJournalPermit';
import {loadBankAllocationOriginal} from '../bank/bankAllocationReversalSources';
import {matchesBankAllocationJournalLines} from './bankAllocationJournalShape';
/** Central registry has already authenticated the live parent permit. */
export async function readBankAllocationReversalJournalRelationship(ctx:ControlTx,control:ParentJournalControl,
 journalId:string,operation:'journal.post'|'journal.reverse'):Promise<unknown[]> {
 const {parent,permit}=control,company=ctx.principal.companyId;
 if(parent.entityType!=='bank_allocation_reversal_intent'||parent.operation!=='bank_allocation.reverse')return[];
 const [intent]=await ctx.sql`SELECT original_intent_id,bank_transaction_id,reversal_date::text FROM control_bank_allocation_reversal_intents
  WHERE company_id=${company}::uuid AND id=${parent.entityId}::uuid` as Array<{original_intent_id:string;bank_transaction_id:string;reversal_date:string}>;
 if(!intent||intent.reversal_date!==permit.accountingDate)return[];
 const original=await loadBankAllocationOriginal(ctx,intent.original_intent_id);
 if(original.plan.bankTransactionId!==intent.bank_transaction_id||original.journal.reversed_at)return[];
 if(operation==='journal.reverse')return journalId===original.journal.id?[{id:journalId,entry_date:original.intent.accounting_date}]:[];
 const headers=await ctx.sql`SELECT id,entry_date::text FROM gl_journal_entries
  WHERE company_id=${company}::uuid AND id=${journalId}::uuid AND status='draft'
   AND reversal_of_id=${original.journal.id}::uuid AND source_record_id=${parent.entityId}::uuid
   AND source=${original.journal.source} AND entry_date=${intent.reversal_date}::date FOR SHARE`;
 if(headers.length!==1)return[];
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,vat_type,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE`;
 const contra=original.sources.lines.map(line=>({...line,debit:line.credit,credit:line.debit}));
 return matchesBankAllocationJournalLines(contra,lines as Parameters<typeof matchesBankAllocationJournalLines>[1])?headers:[];
}
