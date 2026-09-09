import type { ControlTx } from './contracts';
import { assertGeneratedJournal, type ParentJournalControl } from './generatedJournalPermit';

/** The registry proves the owned last period and all-periods-closed relationship. */
export function isAuthorizedYearEndPosting(ctx: ControlTx, control: ParentJournalControl,
  header: Record<string, unknown>, period: Record<string, unknown>, accountingDate: string): boolean {
  if (control.parent.entityType !== 'fiscal_year' || control.parent.operation !== 'year.close') return false;
  assertGeneratedJournal(ctx, control, String(header.id), 'journal.post');
  return header.status === 'draft' && header.source === 'year_end'
    && header.entry_number === `YE-${control.parent.entityId}`
    && period.status === 'closed' && String(period.fiscal_year) === control.parent.entityId
    && period.end_date === accountingDate && control.permit.accountingDate === accountingDate;
}
