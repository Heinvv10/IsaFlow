/**
 * A BULK LOAD IS ONE MATTER, NOT NINETEEN THOUSAND AND NOT NONE.
 *
 * `getUnusualJournals` does not test a bulk load journal by journal for late
 * recording — a day on which the company recorded `BULK_LOAD_MIN` or more
 * journals dated over `BACKDATE_DAYS` days earlier — because Velocity Fibre's
 * September 2026 rebuild made 19 588 "matters" of it. Nor does it drop them:
 * a load that reaches back into a period a board has already been reported
 * on is itself a matter, and one deliberately backdated journal recorded
 * among nine routine ones is inside it. So the load is raised as ONE matter,
 * stating how many journals, on which days, and how far back they are dated.
 * It has no single rand amount, so it prints with the unquantified matters.
 */
import {
  BACKDATE_DAYS,
  BULK_LOAD_MIN,
  type BulkLoadedJournals,
} from '@/modules/accounting/services/reports/unusualJournalsService';
import { BOARD_DECISIONS } from './packMatterDecisions';
import { groupedCount, plural } from './packMatterWords';
import { formatPackDate } from './packPeriodLabel';
import type { PackMatter } from './packMatters';

export function bulkLoadedMatter(b: BulkLoadedJournals, movement: string): PackMatter {
  const when = b.days === 1
    ? `on ${formatPackDate(b.firstRecorded)}`
    : `on ${groupedCount(b.days)} days between ${formatPackDate(b.firstRecorded)} and ${formatPackDate(b.lastRecorded)}`;
  return {
    kind: 'finding',
    issue: `${plural(b.journals, 'journal')} dated as far back as ${formatPackDate(b.oldestEntryDate)} `
      + `${b.journals === 1 ? 'was' : 'were'} recorded in bulk ${when}: ${BULK_LOAD_MIN} or more journals `
      + `dated over ${BACKDATE_DAYS} days earlier were recorded on ${b.days === 1 ? 'that day' : 'each of those days'}, `
      + 'so none is listed here one by one for late recording.',
    quantum: null,
    owner: 'Finance',
    movement,
    decisionRequired: BOARD_DECISIONS.bulkLoadedJournals,
  };
}
