import type {ControlTx} from './contracts';
import type {ParentJournalControl} from './generatedJournalPermit';
import {loadBankAllocationOriginal} from '../bank/bankAllocationReversalSources';
import {matchesBankAllocationJournalLines} from './bankAllocationJournalShape';
/** Central registry has already authenticated the live parent permit. */
export async function readBankAllocationReversalJournalRelationship(ctx:ControlTx,control:ParentJournalControl,
 journalId:string,operation:'journal.post'|'journal.reverse'):Promise<unknown[]> {
 const {parent,permit}=control,company=ctx.principal.companyId;
 if(parent.entityType!=='bank_allocation_reversal_intent'||parent.operation!=='bank_allocation.reverse')return[];
 const [intent]=await ctx.sql`SELECT original_intent_id,legacy_journal_entry_id,bank_transaction_id,reversal_date::text FROM control_bank_allocation_reversal_intents
  WHERE company_id=${company}::uuid AND id=${parent.entityId}::uuid` as Array<{original_intent_id:string|null;legacy_journal_entry_id:string|null;bank_transaction_id:string;reversal_date:string}>;
 if(!intent||intent.reversal_date!==permit.accountingDate)return[];
 if(intent.legacy_journal_entry_id)return legacyProvisionalRelationship(ctx,parent.entityId,intent,journalId,operation);
 const original=await loadBankAllocationOriginal(ctx,String(intent.original_intent_id));
 if(original.plan.bankTransactionId!==intent.bank_transaction_id||original.journal.reversed_at)return[];
 if(operation==='journal.reverse')return journalId===original.journal.id?[{id:journalId,entry_date:original.intent.accounting_date}]:[];
 const headers=await ctx.sql`SELECT id,entry_date::text FROM gl_journal_entries
  WHERE company_id=${company}::uuid AND id=${journalId}::uuid AND status='draft'
   AND reversal_of_id=${original.journal.id}::uuid AND source_record_id=${parent.entityId}::uuid
   AND source=${original.journal.source} AND entry_date=${intent.reversal_date}::date FOR SHARE`;
 if(headers.length!==1)return[];
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE`;
 const contra=original.sources.lines.map(line=>({...line,debit:line.credit,credit:line.debit}));
 return matchesBankAllocationJournalLines(contra,lines as Parameters<typeof matchesBankAllocationJournalLines>[1])?headers:[];
}
/**
 * The same two relationships for a reversal whose original is a journal PROVEN from the data: the journal itself for
 * the reverse, and the contra that mirrors its lines for the post. The proof is re-taken here, so a journal that has
 * stopped being a reversible provisional entry between the approval and the write registers nothing.
 */
async function legacyProvisionalRelationship(ctx:ControlTx,intentId:string,
 intent:{legacy_journal_entry_id:string|null;bank_transaction_id:string;reversal_date:string},
 journalId:string,operation:'journal.post'|'journal.reverse'):Promise<unknown[]>{
 const company=ctx.principal.companyId;
 const {loadLegacyProvisionalOriginal,isLegacyProvisionalContra}=await import('../bank/bankAllocationLegacyProvisional');
 const original=await loadLegacyProvisionalOriginal(ctx,String(intent.legacy_journal_entry_id));
 if(String(original.bank.id)!==intent.bank_transaction_id)return[];
 if(operation==='journal.reverse')return journalId===original.journal.id?[{id:journalId,entry_date:String(original.journal.entry_date)}]:[];
 const headers=await ctx.sql`SELECT id,entry_date::text FROM gl_journal_entries
  WHERE company_id=${company}::uuid AND id=${journalId}::uuid AND status='draft'
   AND reversal_of_id=${String(original.journal.id)}::uuid AND source_record_id=${intentId}::uuid
   AND source='auto_bank_recon' AND entry_date=${intent.reversal_date}::date FOR SHARE`;
 if(headers.length!==1)return[];
 const lines=await ctx.sql`SELECT gl_account_id,debit::text AS debit,credit::text AS credit,vat_type,cost_center_id,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE` as Record<string,unknown>[];
 return isLegacyProvisionalContra(original,lines)?headers:[];
}
