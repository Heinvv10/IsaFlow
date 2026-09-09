import { isRealCalendarDate } from '@/lib/validation';
import type { ControlTx, OperationRef } from '../controls/contracts';
import { assertControlTx } from '../controls/context';
type Row = Record<string, unknown>;
export function chooseApReversalDate(original: string, status: string, today: string, requested?: string): string {
  const target = requested ?? (status === 'open' ? original : today);
  if (!isRealCalendarDate(original) || !isRealCalendarDate(target) || target < original) throw new Error('Invalid AP reversal date');
  return target;
}
/** Parent is already locked by the materializer; fiscal facts stay locked through the effect. */
export async function resolveApReversalMaterial(ctx: ControlTx, ref: OperationRef, journalId: unknown, documentDate: string) {
  assertControlTx(ctx);
  const requested = (ref as OperationRef & { reversalDate?: string }).reversalDate;
  if (!['supplier_payment.void', 'supplier_invoice.cancel'].includes(ref.operation)) {
    if (requested !== undefined) throw new Error('Reversal date is only valid for reversal operations');
    return { accountingDate: documentDate, facts: null };
  }
  // A draft cancellation has no financial reversal; do not invent a target journal.
  if (!journalId) {
    if (requested !== undefined && requested !== documentDate) throw new Error('No journal to reverse');
    return { accountingDate: documentDate, facts: null };
  }
  const company = ctx.principal.companyId;
  const [journal] = await ctx.sql`SELECT id,entry_date::text,fiscal_period_id FROM gl_journal_entries
    WHERE company_id=${company}::uuid AND id=${String(journalId)}::uuid FOR SHARE` as Row[];
  if (!journal) throw new Error('Owned reversal journal unavailable');
  const original = String(journal.entry_date);
  const periods = await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${company}::uuid AND start_date<=${original}::date AND end_date>=${original}::date ORDER BY id FOR SHARE` as Row[];
  if (periods.length !== 1 || periods[0]!.id !== journal.fiscal_period_id) throw new Error('Original AP fiscal period missing or ambiguous');
  const [clock] = await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as { day: string }[];
  if (!clock) throw new Error('AP execution date unavailable');
  const accountingDate = chooseApReversalDate(original, String(periods[0]!.status), clock.day, requested);
  const targets = accountingDate === original ? periods : await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${company}::uuid AND start_date<=${accountingDate}::date AND end_date>=${accountingDate}::date ORDER BY id FOR SHARE` as Row[];
  if (targets.length !== 1) throw new Error('Target AP fiscal period missing or ambiguous');
  return { accountingDate, facts: { journal, originalPeriod: periods[0]!, targetPeriod: targets[0]!, accountingDate } };
}
