/**
 * WHAT THE LATE-RECORDING TEST SKIPPED, IN ONE SENTENCE FOR TWO PAGES.
 *
 * `getUnusualJournals` leaves a bulk load out of the backdating test — a day
 * on which the company recorded `BULK_LOAD_MIN` or more journals dated over
 * `BACKDATE_DAYS` days earlier is a ledger being loaded or rebuilt, not a
 * period moving. Velocity Fibre's September 2026 reload had made 19 588
 * "matters" of it. A check that leaves something out says so where it
 * reports: page 11's "What was checked", and page 4, whose action panel is
 * drawn from the same checks. One sentence, so the two cannot describe the
 * same skip differently.
 */
import {
  BACKDATE_DAYS,
  BULK_LOAD_MIN,
  type BulkLoadedJournals,
} from '@/modules/accounting/services/reports/unusualJournalsService';
import { mustDisclose, note } from './packBlockBuilders';
import { groupedCount, plural } from './packMatterWords';
import { formatPackDate } from './packPeriodLabel';
import type { PackPageBlock } from './packPageModel';

export function bulkLoadedSentence(b: BulkLoadedJournals): string {
  const when = b.days === 1
    ? `on ${formatPackDate(b.firstRecorded)}, a day that`
    : `on ${groupedCount(b.days)} days between ${formatPackDate(b.firstRecorded)} and `
      + `${formatPackDate(b.lastRecorded)}, each a day that`;
  return `${plural(b.journals, 'journal')} recorded in bulk ${when} recorded ${BULK_LOAD_MIN} or more `
    + `dated over ${BACKDATE_DAYS} days earlier, ${b.journals === 1 ? 'is' : 'are'} not tested for late `
    + 'recording, which a reload trips on every journal. The round-number test still covers them.';
}

/** Page 4's statement of it — a disclosure that must print, or null where
 *  nothing was skipped. */
export function bulkLoadedNote(b: BulkLoadedJournals | null): PackPageBlock | null {
  return b === null ? null : mustDisclose('Journals recorded in bulk', [note('Late recording', bulkLoadedSentence(b))]);
}
