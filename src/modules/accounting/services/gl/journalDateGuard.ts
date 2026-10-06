/**
 * sec-numrace S4: the ledger-date window (utils/journalDateWindow) enforced once at the funnel — createJournalEntry's
 * first statement — and before the two journal writers that INSERT gl_journal_entries themselves (asset depreciation,
 * the year-end closing journal), whose dates come from tenant-created fiscal periods.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { JournalDateRefusedError, journalDateWindowError } from '../../utils/journalDateWindow';

/**
 * Throws JournalDateRefusedError for an entry date outside 1900-01-01..2199-12-31, before this journal writes. It
 * records whether the request had written anything yet (no transaction id assigned): a refusal after an earlier write
 * must not be a 4xx, which would COMMIT that write (lib/apiJournalDate).
 */
export async function assertJournalDateInWindow(entryDate: string | Date): Promise<void> {
  const reason = journalDateWindowError(typeof entryDate === 'string' ? entryDate : fmtDate(entryDate));
  if (!reason) return;
  const rows = (await sql`SELECT pg_current_xact_id_if_assigned() IS NULL AS clean`) as { clean: boolean }[];
  throw new JournalDateRefusedError(reason, rows[0]?.clean === true);
}
