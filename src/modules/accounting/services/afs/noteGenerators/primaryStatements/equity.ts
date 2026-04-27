// Statement of Changes in Equity generator (v1).
//
// V1 limitation: the "Movement" column is computed as
// (closing balance - opening balance), which conflates "true equity
// movement" (e.g. profit for the year, dividends, share issues) with
// any prior-year adjustment. For BS045 Accumulated profit (loss),
// the proper movement = profit-for-year (from the IS); the v1 figure
// is "close enough" for most no-OCI tenants but should be reconciled
// before signed-off AFS. Tracked as a follow-up.

import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, fiscalRange } from '../noteHelpers';
import { fetchSectionLines } from './_helpers';

const EQUITY_CODES = new Set(['BS043', 'BS044', 'BS045', 'BS046', 'BS047', 'BS048']);

export async function generateChangesInEquity(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateChangesInEquity', { companyId, fiscalYear }, 'AfsPrimary');
  const lines = await fetchSectionLines(companyId, 'balance_sheet', fiscalYear, fiscalYear - 1);
  const equityLines = lines.filter((l) => EQUITY_CODES.has(l.code));

  const rows: string[][] = equityLines.map((l) => [
    l.label,
    fmt(-l.priorAmount),
    fmt(-(l.currentAmount - l.priorAmount)),
    fmt(-l.currentAmount),
  ]);

  return {
    dataSnapshot: { equityLines },
    content: {
      title: 'Statement of Changes in Equity',
      blocks: [
        { type: 'paragraph', text: `Movements in equity for the year ended ${fiscalRange(fiscalYear).end}.` },
        {
          type: 'table',
          headers: ['Component', 'Opening (R)', 'Movement (R)', 'Closing (R)'],
          rows,
        },
        { type: 'paragraph', text: 'Movement column is the period delta of cumulative balances. v1 limitation: see Notes for true profit-for-year and dividend movements.' },
      ],
    },
  };
}
