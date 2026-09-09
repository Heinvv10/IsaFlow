import {assertControlledEffectPermit} from './approvalExecutionService';
import type {ControlTx} from './contracts';
import type {ParentJournalControl} from './generatedJournalPermit';
/** Parent headers are locked by materialization; immutable recurring links identify the actual invoice. */
export async function readArJournalRelationship(ctx:ControlTx,control:ParentJournalControl,journalId:string,
 operation:'journal.post'|'journal.reverse'):Promise<unknown[]>{
 assertControlledEffectPermit(ctx,control.permit,control.parent);
 const parent=control.parent,company=ctx.principal.companyId;
 if(!['customer_invoice','customer_payment','credit_note','recurring_invoice_run'].includes(parent.entityType))return [];
 return ctx.sql`SELECT je.id,je.entry_date::text AS entry_date FROM gl_journal_entries je JOIN (
  SELECT ci.id AS source_id,ci.gl_journal_entry_id AS original_id,'auto_invoice'::text AS source,
   'customer_invoice.post'::text AS post_operation,'customer_invoice.cancel'::text AS reverse_operation
  FROM customer_invoices ci WHERE ci.company_id=${company}::uuid AND ci.id=${parent.entityId}::uuid AND ${parent.entityType}='customer_invoice'
  UNION ALL
  SELECT cp.id,cp.gl_journal_entry_id,'auto_payment','customer_payment.confirm','customer_payment.cancel'
  FROM customer_payments cp WHERE cp.company_id=${company}::uuid AND cp.id=${parent.entityId}::uuid AND ${parent.entityType}='customer_payment'
  UNION ALL
  SELECT cn.id,cn.gl_journal_entry_id,'auto_credit_note','credit_note.approve','credit_note.cancel'
  FROM credit_notes cn WHERE cn.company_id=${company}::uuid AND cn.id=${parent.entityId}::uuid AND ${parent.entityType}='credit_note'
  UNION ALL
  SELECT ci.id,ci.gl_journal_entry_id,'auto_invoice','recurring_invoice.generate',NULL
  FROM control_recurring_invoice_runs run JOIN customer_invoices ci ON ci.company_id=run.company_id AND ci.id=run.invoice_id
  WHERE run.company_id=${company}::uuid AND run.id=${parent.entityId}::uuid AND ${parent.entityType}='recurring_invoice_run'
 ) p ON true WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid
 AND ((${operation}='journal.post' AND ${parent.operation}=p.post_operation AND je.status='draft'
   AND je.source=p.source AND je.source_record_id=p.source_id AND je.entry_date=${control.permit.accountingDate}::date)
  OR (${operation}='journal.reverse' AND ${parent.operation}=p.reverse_operation AND je.status='posted' AND je.id=p.original_id)
  OR (${operation}='journal.post' AND ${parent.operation}=p.reverse_operation AND je.status='draft' AND je.reversal_of_id=p.original_id
   AND je.entry_date=${control.permit.accountingDate}::date AND EXISTS(SELECT 1 FROM gl_journal_entries original
    WHERE original.company_id=je.company_id AND original.id=je.reversal_of_id AND original.status='posted' AND original.source=je.source)))
 FOR SHARE OF je`;
}
