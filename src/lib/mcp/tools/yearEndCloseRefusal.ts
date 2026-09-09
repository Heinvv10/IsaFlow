/**
 * Every typed refusal `year_end_close` can hand back, as the sentence an agent
 * reads.
 *
 * Split out of `writeFiscalPeriods.ts` only for size: these are long on purpose.
 * A refusal an unattended caller cannot act on is a refusal it retries, and a
 * year-end close is the one write here that posts to equity and then LOCKS
 * every period behind it — so each one has to name the row or the setting that
 * has to change, and say plainly that nothing was posted.
 */
import type { McpToolResult } from '../types';
import type { CloseYearError } from '@/modules/accounting/services/gl/yearEndService';
import { toolError } from './toolHelpers';

export function yearEndCloseRefusal(year: number, result: CloseYearError): McpToolResult {
  if (result.error === 'open_periods') {
    return toolError(
      `Fiscal year ${year} has ${result.count} open period`
      + `${result.count === 1 ? '' : 's'}: `
      + `${result.openPeriods.map((p) => p.periodName).join(', ')}. `
      + 'Close each of them with close_fiscal_period first. Nothing was posted.',
    );
  }
  if (result.error === 'period_range_mismatch') {
    return toolError(
      `Fiscal year ${year}'s periods run ${result.actual.startDate} to ${result.actual.endDate}, `
      + `but this company's financial year starts in month ${result.startMonth}, so `
      + `FY${year} is really ${result.expected.startDate} to ${result.expected.endDate}. `
      + 'Closing the periods as they stand would roll the wrong twelve months into retained '
      + 'earnings and then LOCK them, and nothing would look wrong afterwards because the '
      + 'journal balances either way. Nothing was posted. '
      + 'THE FIX IS NOT THIS TOOL. The periods themselves are misaligned with the financial '
      + 'year, and the year-end close is downstream of that: re-dating live fiscal periods is '
      + 'a data correction that needs a person to decide it, not something a close should do '
      + 'on the way past. Call list_fiscal_periods and read `alignment` — when `aligned` is '
      + 'false, that is the thing to fix, and this close will work once it is.',
    );
  }
  if (result.error === 'no_fiscal_period') {
    return toolError(
      `No fiscal period covers ${result.entryDate}, where the closing journal would be dated. `
      + 'Posting it without one would leave it outside the trial balance, the VAT201 and the '
      + 'AFS permanently. Nothing was posted.',
    );
  }
  if (result.error === 'ambiguous_retained_earnings') {
    return toolError(
      `More than one account could be retained earnings (${result.accountCodes.join(', ')}) `
      + 'so the close refuses rather than breaking the tie. Posting a year of trading into '
      + 'the wrong equity account and then locking every period behind it is not recoverable '
      + 'in place. Leave the role on exactly one account with update_gl_account. '
      + 'Nothing was posted.',
    );
  }
  if (result.error === 'closing_journal_not_posted') {
    return toolError(
      `Fiscal year ${year} has a closing journal (${result.entryNumber}, id ${result.entryId}) `
      + `in status ${result.status}. The year is NOT closed — a reversed or draft closing `
      + 'journal has posted nothing — but it cannot be closed again either, because that row '
      + 'holds the entry number and it is unique per company. A person has to delete or '
      + 'renumber that journal first. Nothing was posted.',
    );
  }
  if (result.error === 'closing_entry_number_taken') {
    return toolError(
      `Fiscal year ${year} cannot be closed: journal ${result.entryId} — a ${result.source} `
      + `journal in status ${result.status}, NOT a year-end close — already carries entry `
      + `number ${result.entryNumber}, which is the number this close needs. Entry numbers `
      + 'are unique per company with no predicate on source or status, so that row blocks '
      + 'the INSERT. The year is not closed and nothing was posted. A person has to renumber '
      + 'that journal first; do not retry until they have.',
    );
  }
  if (result.error === 'no_retained_earnings') {
    return toolError(
      'No account carries the retained_earnings system role for this company. Create one with '
      + 'create_gl_account, or set the subtype on the existing equity account with '
      + 'update_gl_account. Nothing was posted.',
    );
  }
  return toolError(`Fiscal year ${year} has no periods. Nothing was posted.`);
}
