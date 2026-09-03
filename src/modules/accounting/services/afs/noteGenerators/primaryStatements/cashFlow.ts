// Cash Flow Statement generator (v1 skeleton).
//
// V1: opening cash + net movement + closing cash. Pulls from any GL
// account with subtype IN ('bank','cash','petty_cash'). Tenants with
// custom subtypes get a zero cash flow with a warning logged so an
// operator can spot the misconfiguration.
//
// V2 (tracked separately): split operating / investing / financing
// activities, indirect-method working-capital movements.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum } from '../noteHelpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

type DbRow = Record<string, unknown>;

export async function generateCashFlow(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateCashFlow', { companyId, fiscalYear }, 'AfsPrimary');
  const { start, end } = await getFiscalRange(companyId, fiscalYear);
  const cashRows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN gje.entry_date < ${start}::date THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS opening,
      COALESCE(SUM(CASE WHEN gje.entry_date <= ${end}::date THEN gjl.debit - gjl.credit ELSE 0 END), 0) AS closing,
      COUNT(DISTINCT ga.id) AS cash_account_count
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}::uuid
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id AND gje.status = 'posted' AND gje.company_id = ${companyId}::uuid
    WHERE ga.company_id = ${companyId}::uuid
      AND ga.account_subtype IN ('bank', 'cash', 'petty_cash')
  `) as DbRow[];
  const opening = toNum(cashRows[0]?.opening);
  const closing = toNum(cashRows[0]?.closing);
  const cashAccountCount = Number(cashRows[0]?.cash_account_count ?? 0);
  const netMovement = closing - opening;

  if (cashAccountCount === 0) {
    log.warn(
      'Cash flow: no GL accounts with subtype bank/cash/petty_cash — tenant may use custom subtypes',
      { companyId, fiscalYear },
      'AfsPrimary',
    );
  }

  return {
    dataSnapshot: { opening, closing, netMovement, cashAccountCount },
    content: {
      title: 'Statement of Cash Flows',
      blocks: [
        { type: 'paragraph', text: `For the year ended ${end}. Indirect method (v1 skeleton).` },
        {
          type: 'table',
          headers: ['Line', 'Current year (R)'],
          rows: [
            ['Cash and equivalents at beginning of year', fmt(opening)],
            ['Net movement during year', fmt(netMovement)],
            ['**Cash and equivalents at end of year**', fmt(closing)],
          ],
        },
        { type: 'paragraph', text: 'Detailed operating, investing and financing cash flows are pending implementation.' },
      ],
    },
  };
}
