import type {ControlTx} from './contracts';
import type {ParentJournalControl} from './generatedJournalPermit';
import {loadBankAllocationIntent} from '../bank/bankAllocationMaterial';
import {matchesBankAllocationJournalLines} from './bankAllocationJournalShape';
/** Called only after the central registry authenticates its private live parent permit. */
export async function readBankAllocationJournalRelationship(ctx:ControlTx,control:ParentJournalControl,
 journalId:string,operation:'journal.post'|'journal.reverse'):Promise<unknown[]> {
 const {parent,permit}=control;
 if(operation!=='journal.post'||parent.operation!=='bank_allocation.post'||parent.entityType!=='bank_allocation_intent')return[];
 const {intent,plan,sources}=await loadBankAllocationIntent(ctx,parent.entityId);
 if(plan.kind==='transfer'&&plan.transfer.mode!=='post')return[];
 const source=plan.kind==='transfer'?'auto_bank_transfer':plan.kind==='customer'?'auto_payment':plan.kind==='supplier'?'auto_supplier_payment':'auto_bank_recon';
 const headers=await ctx.sql`SELECT je.id,je.entry_date::text AS entry_date FROM gl_journal_entries je
  WHERE je.company_id=${ctx.principal.companyId}::uuid AND je.id=${journalId}::uuid AND je.status='draft'
   AND je.source=${source} AND je.source_record_id=${intent.bank_transaction_id}::uuid
   AND je.entry_date=${intent.accounting_date}::date AND je.entry_date=${permit.accountingDate}::date FOR SHARE`;
 if(headers.length!==1)return[];
 const lines=await ctx.sql`SELECT gl_account_id,debit::text,credit::text,vat_type,cost_center_id,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${ctx.principal.companyId}::uuid AND journal_entry_id=${journalId}::uuid ORDER BY id FOR SHARE`;
 return matchesBankAllocationJournalLines(sources.lines,lines as Parameters<typeof matchesBankAllocationJournalLines>[1])?headers:[];
}
