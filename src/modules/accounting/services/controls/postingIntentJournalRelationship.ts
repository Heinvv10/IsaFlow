import { assertControlledEffectPermit } from './approvalExecutionService';
import type { ControlTx } from './contracts';
import type { ParentJournalControl } from './generatedJournalPermit';

/** Fixed relationship reads for the central generated-journal registry; this does not register capabilities. */
export async function readPostingIntentJournalRelationship(ctx: ControlTx, control: ParentJournalControl,
  journalId: string, operation: 'journal.post' | 'journal.reverse'): Promise<unknown[]> {
  assertControlledEffectPermit(ctx, control.permit, control.parent);
  if (operation !== 'journal.post') return [];
  const { parent, permit } = control, company = ctx.principal.companyId;
  if (parent.entityType === 'bank_transfer_intent' && parent.operation === 'bank_transfer.post') {
    return ctx.sql`SELECT je.id,je.entry_date::text AS entry_date FROM gl_journal_entries je
      JOIN control_bank_transfer_intents p ON p.company_id=je.company_id AND p.id=je.source_record_id
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid AND p.id=${parent.entityId}::uuid
        AND je.source='bank_transfer' AND je.status='draft' AND je.entry_date=p.accounting_date
        AND je.entry_date=${permit.accountingDate}::date
        AND (SELECT count(*) FROM gl_journal_lines l WHERE l.company_id=je.company_id AND l.journal_entry_id=je.id)=2
        AND EXISTS(SELECT 1 FROM gl_journal_lines l WHERE l.company_id=je.company_id AND l.journal_entry_id=je.id
          AND l.gl_account_id=p.from_gl_account_id AND l.debit=0 AND l.credit=p.amount)
        AND EXISTS(SELECT 1 FROM gl_journal_lines l WHERE l.company_id=je.company_id AND l.journal_entry_id=je.id
          AND l.gl_account_id=p.to_gl_account_id AND l.debit=p.amount AND l.credit=0)
      FOR SHARE OF je`;
  }
  if (parent.entityType === 'asset_depreciation_intent' && parent.operation === 'asset_depreciation.post') {
    return ctx.sql`SELECT je.id,je.entry_date::text AS entry_date FROM gl_journal_entries je
      JOIN control_asset_depreciation_intents p ON p.company_id=je.company_id AND p.id=je.source_record_id
      JOIN assets a ON a.company_id=p.company_id AND a.id=p.asset_id
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid AND p.id=${parent.entityId}::uuid
        AND je.source='auto_depreciation' AND je.status='draft' AND je.entry_date=p.period_date
        AND je.entry_date=${permit.accountingDate}::date
      FOR SHARE OF je,a`;
  }
  if (parent.entityType === 'fiscal_year' && parent.operation === 'year.close') {
    return ctx.sql`SELECT je.id,je.entry_date::text AS entry_date FROM gl_journal_entries je
      JOIN fiscal_periods p ON p.company_id=je.company_id AND p.id=je.fiscal_period_id
      WHERE je.company_id=${company}::uuid AND je.id=${journalId}::uuid AND p.fiscal_year=${parent.entityId}::integer
        AND je.source='year_end' AND je.entry_number=${`YE-${parent.entityId}`} AND je.status='draft'
        AND p.status='closed' AND je.entry_date=p.end_date AND je.entry_date=${permit.accountingDate}::date
        AND NOT EXISTS(SELECT 1 FROM fiscal_periods other WHERE other.company_id=p.company_id
          AND other.fiscal_year=p.fiscal_year AND other.status<>'closed')
      FOR SHARE OF je,p`;
  }
  return [];
}
