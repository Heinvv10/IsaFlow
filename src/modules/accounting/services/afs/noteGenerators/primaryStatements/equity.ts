// Statement of Changes in Equity generator (v1).
//
// V1 limitation: the "Movement" column is computed as
// (closing balance - opening balance), which conflates "true equity
// movement" (e.g. profit for the year, dividends, share issues) with
// any prior-year adjustment. For BS045 Accumulated profit (loss),
// the proper movement = profit-for-year (from the IS); the v1 figure
// is "close enough" for most no-OCI tenants but should be reconciled
// before signed-off AFS. Tracked as a follow-up.
//
// Dividends paid on an equity account mapped to IS484 (dividendsPaid.ts) are
// split out of the accumulated-profit row's movement into a Dividends column,
// shown only in a year that has them.

import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fmt } from '../noteHelpers';
import { fetchSectionLines, type SectionLine } from './_helpers';
import { ACCUMULATED_PROFIT_CODE, DERIVED_ACCUMULATED_PROFIT_CODE } from './derivedAccumulatedProfit';
import { fetchDividendsPaid } from './dividendsPaid';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

// BSACCPL: the derived accumulated-profit line a taxonomy without BS045 gets (derivedAccumulatedProfit.ts).
const EQUITY_CODES = new Set(['BS043', 'BS044', 'BS045', 'BS046', 'BS047', 'BS048', DERIVED_ACCUMULATED_PROFIT_CODE]);

export async function generateChangesInEquity(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateChangesInEquity', { companyId, fiscalYear }, 'AfsPrimary');
  const { start: fyStart, end: fyEnd } = await getFiscalRange(companyId, fiscalYear);
  const [lines, dividendsPaid] = await Promise.all([
    fetchSectionLines(companyId, 'balance_sheet', fiscalYear, fiscalYear - 1),
    // Paid only: clearing the dividends account into retained earnings is not a distribution.
    fetchDividendsPaid(companyId, fyStart, fyEnd, true),
  ]);
  const equityLines = lines.filter((l) => EQUITY_CODES.has(l.code));

  // Credit-positive like the other columns, so a dividend paid reduces equity. The derived profit lands on
  // BS045, or on BSACCPL when the taxonomy has no BS045 (derivedAccumulatedProfit), and so do the dividends.
  const isAccumulated = (l: SectionLine): boolean =>
    l.code === ACCUMULATED_PROFIT_CODE || l.code === DERIVED_ACCUMULATED_PROFIT_CODE;
  // No accumulated-profit row (a taxonomy with neither BS045 nor a total equity line): the SFP carries neither the
  // derived profit nor the dividends, so the column is not shown rather than shown as zeros.
  const showDividends = dividendsPaid !== 0 && equityLines.some(isAccumulated);
  const dividendsOn = (l: SectionLine): number => (isAccumulated(l) ? -dividendsPaid : 0);
  const rows: string[][] = equityLines.map((l) => [
    l.label,
    fmt(-l.priorAmount),
    ...(showDividends ? [fmt(dividendsOn(l))] : []),
    fmt(-(l.currentAmount - l.priorAmount) - dividendsOn(l)),
    fmt(-l.currentAmount),
  ]);

  return {
    // closingTotalEquity: the key the compliance checker compares to the SFP's totalEquity (credit-positive).
    // dividendsPaid: the year's dividends on IS484-mapped equity accounts, as a positive amount paid.
    dataSnapshot: {
      equityLines, dividendsPaid,
      closingTotalEquity: -equityLines.filter((l) => !l.isTotal).reduce((s, l) => s + l.currentAmount, 0),
    },
    content: {
      title: 'Statement of Changes in Equity',
      blocks: [
        { type: 'paragraph', text: `Movements in equity for the year ended ${fyEnd}.` },
        {
          type: 'table',
          headers: ['Component', 'Opening (R)', ...(showDividends ? ['Dividends (R)'] : []), 'Movement (R)', 'Closing (R)'],
          rows,
        },
        { type: 'paragraph', text: showDividends
          ? 'Movement column is the period delta of cumulative balances, less the dividends paid shown beside it. v1 limitation: see Notes for true profit-for-year.'
          : 'Movement column is the period delta of cumulative balances. v1 limitation: see Notes for true profit-for-year and dividend movements.' },
      ],
    },
  };
}
