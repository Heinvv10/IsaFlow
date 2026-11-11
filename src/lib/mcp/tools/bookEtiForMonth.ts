/**
 * book_eti_for_month — the connector's "Book ETI for this month" (wave 5 ET, review round 4, coordinator ruling M1(c)).
 * Brings a run-less month's ETI journal (ETI-YYYY-MM) to what the EMP201 declares: ETI used and, in August or February,
 * the refund (ETI Act s9(1), s10(1)). The same rebook every payroll trigger runs (etiRebook.bookEtiForMonth), under the
 * company payroll approval lock; idempotent. It POSTS a journal, so write:payroll plus write:post, as approve_pay_run.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { bookEtiForMonthLocked, previewEtiForMonth } from '@/modules/accounting/services/payroll/etiRebook';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import { ok, strArg, toolError } from './toolHelpers';

const BOOK_ETI_TOOL_AGENT = 'mcp:book_eti_for_month:v1';
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const bookEtiForMonthTool: McpTool = {
  name: 'book_eti_for_month',
  description:
    'Book a month\'s Employment Tax Incentive in the ledger as the EMP201 declares it: posts the month\'s ETI journal '
    + '(reference ETI-YYYY-MM; DR PAYE payable / CR labour cost for ETI used, DR ETI refund receivable / CR labour cost for an '
    + 'August or February refund). For a month with no pay run journal in force (a directive-only month, or no run at all); a '
    + 'month whose run journal is in force books its own ETI, and a month that has not ended is refused. Idempotent: a month '
    + 'already booked posts nothing. Use it when emp201_status or the data integrity check paye_payable_differs_from_emp201 '
    + 'shows a month\'s ETI unbooked (for example after an ETI journal was reversed by hand). Dated the month\'s last day, or the '
    + 'first open date when that period is closed. Posts to the general ledger: requires write:post. dry_run: true previews it.',
  scope: 'write:payroll',
  requiresWriteRole: true,
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'The EMP201 month, YYYY-MM.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['month', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const raw = strArg(args, 'month');
    const m = raw ? MONTH.exec(raw) : null;
    if (!m) return toolError('month is required, as YYYY-MM');
    const ym = { year: Number(m[1]), month: Number(m[2]) };
    if (args.dry_run === true) {
      return { ...ok({ dryRun: true, wroteNothing: true, ...(await previewEtiForMonth(ctx.companyId, ym)) }), wroteNothing: true };
    }
    let outcome;
    try {
      outcome = await bookEtiForMonthLocked(ctx.companyId, ym, ctx.userId, BOOK_ETI_TOOL_AGENT);
    } catch (err) {
      // The bounded wait for lock 1 ran out (a pay run is being approved): before any write, so safe to answer.
      if (err instanceof PayrollLoanLockTimeoutError) return toolError(err.message);
      throw err;
    }
    if (outcome.status === 'not_ended') return toolError(`${outcome.month} has not ended: its ETI is booked after its last day.`);
    if (outcome.status === 'no_open_period') return toolError(`No open fiscal period on or after the end of ${outcome.month}: open one, then try again.`);
    return ok({ month: outcome.month, status: outcome.status, journal_entry_id: outcome.journalEntryId, entry_date: outcome.entryDate });
  },
};
