/**
 * The sentence (and HTTP class) for each typed year-end close refusal.
 *
 * Shared by the POST close and the GET `?preview=` read on
 * `/api/accounting/year-end`, so the confirmation dialog shows the operator the
 * exact refusal the close itself would answer with. Wording moved here
 * unchanged from the route.
 */

import type { CloseYearError } from '@/modules/accounting/services/gl/yearEndCloseTypes';

export interface YearEndCloseRefusal {
  kind: 'badRequest' | 'notFound' | 'conflict';
  message: string;
  details?: Record<string, unknown>;
}

export function yearEndCloseRefusal(result: CloseYearError): YearEndCloseRefusal {
  switch (result.error) {
    case 'open_periods':
      return { kind: 'badRequest', message: `${result.count} periods still open. Close all periods first.` };
    case 'year_not_found':
      return { kind: 'notFound', message: 'Fiscal year not found' };
    case 'start_month_assumed':
      return {
        kind: 'badRequest',
        message: 'This company has no financial year start month set, so this year was cut on an assumed ' +
          'March start. Set the start month in Settings, then run the year-end close again.',
      };
    case 'no_retained_earnings':
      return {
        kind: 'badRequest',
        message: 'No Retained Earnings system account is configured. Mark the equity ' +
          "account as a system account with account_subtype 'retained_earnings', " +
          'then run the year-end close again.',
      };
    case 'ambiguous_retained_earnings':
      return {
        kind: 'badRequest',
        message: `More than one account is flagged as the Retained Earnings system account ` +
          `(${result.accountCodes.join(', ')}). Year-end close posts the whole year's ` +
          `result to one account, so it will not guess. Un-flag all but one and try again.`,
      };
    case 'no_fiscal_period':
      return {
        kind: 'badRequest',
        message: `No fiscal period covers ${result.entryDate}, where the closing journal has to ` +
          `land. Create the period that covers the last day of the year, then close again.`,
      };
    case 'period_range_mismatch':
      return {
        kind: 'badRequest',
        message: `The periods labelled this fiscal year run ${result.actual.startDate} to ` +
          `${result.actual.endDate}, but this company's financial year with that label runs ` +
          `${result.expected.startDate} to ${result.expected.endDate}. Closing the labelled ` +
          `span would roll the wrong months into equity and lock them. To move the year end, ` +
          `use Change financial year end; otherwise fix the period dates, then close again.`,
      };
    case 'closing_journal_not_posted':
      return {
        kind: 'conflict',
        message: `This year already has a closing journal (${result.entryNumber}) and it is `
          + `${result.status}, not posted. The year is therefore NOT closed, but it also `
          + `cannot be closed again while that entry holds the number (a reversed closing `
          + `journal does not block: the next close takes the next -R<n> number). Delete or renumber `
          + `journal ${result.entryId}, then close the year.`,
      };
    case 'closing_entry_number_taken':
      return {
        kind: 'conflict',
        message: `Journal ${result.entryId} already carries the entry number this year's closing `
          + `journal needs (${result.entryNumber}). It is a ${result.source} journal in `
          + `status ${result.status}, not a year-end close, so the year is NOT closed, but `
          + `entry numbers are unique per company, so it cannot be closed while that row `
          + `holds the number. Renumber journal ${result.entryId}, then close the year.`,
      };
    case 'too_many_recloses':
      return {
        kind: 'conflict',
        message: `Closing journal ${result.entryNumber} has been reversed and re-posted too many times. `
          + `Nothing was posted; a person has to look at the reversals before the year is closed again.`,
        details: { code: result.code },
      };
    case 'closing_chain_unreadable':
      return {
        kind: 'conflict',
        message: `The reversal chain of closing journal ${result.entryNumber} is too long to read, so it `
          + `cannot be told whether the year is closed. Nothing was posted; a person has to inspect it.`,
        details: { code: result.code },
      };
    default: {
      // Exhaustive over CloseYearError: `unhandled` stops being `never` the
      // moment a member is added without a case, so a new refusal cannot fall
      // through to a 200.
      const unhandled: never = result;
      return { kind: 'badRequest', message: `Year-end close was refused (${String((unhandled as { error?: unknown }).error)}).` };
    }
  }
}
