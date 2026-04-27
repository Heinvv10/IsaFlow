/**
 * Unposted journals close-readiness check.
 *
 * Counts journal entries in the fiscal period that are not yet posted.
 * Any status other than 'posted' (e.g. 'draft', 'pending') counts as unposted.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';

type Row = DbRow;

export async function unpostedJournalsCheck(
  companyId: string,
  period: { id: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS draft_count
    FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND fiscal_period_id = ${period.id}::UUID
      AND status != 'posted'
  `) as Row[];

  const count = Number(rows[0]?.draft_count ?? 0);

  if (count === 0) {
    return {
      key: 'unposted_journals',
      label: 'Unposted journals',
      status: 'pass',
      reason: 'All journal entries in this period are posted.',
      fixHref: '/accounting/journal-entries',
    };
  }

  return {
    key: 'unposted_journals',
    label: 'Unposted journals',
    status: 'fail',
    reason: `${count} unposted journal entr${count === 1 ? 'y' : 'ies'} in this period.`,
    fixHref: '/accounting/journal-entries?filter=draft',
  };
}
