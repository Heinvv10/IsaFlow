// Income Statement generator.
//
// Revenue and other-income lines are credit-positive in the GL; the IS
// reads with positive numbers. Sign-flip those branches so the user
// sees Revenue (positive) less Expenses (positive). Sign-flip is driven
// by an explicit revenue code-set (not just a prefix) so below-the-line
// finance income / interest received / dividends received are also
// correctly positive.

import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fetchSectionLines, rollUpTotals, renderHierarchicalTable, flipSign, type SectionLine } from './_helpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

// Codes whose GL balance is naturally credit-positive (revenue, other
// income, finance income, dividends, etc.) — render positive on the IS.
// Sourced from afsMappingService.ts BS_LINES + IS_LINES (lines 493-695).
const REVENUE_CODES = new Set([
  // Revenue header + children
  'IS001', 'IS002', 'IS003', 'IS006', 'IS007', 'IS010', 'IS011', 'IS012', 'IS013',
  // Other income header + children
  'IS124', 'IS131', 'IS132', 'IS133', 'IS135', 'IS139', 'IS143',
  // Below-the-line finance income / dividends
  'IS461', 'IS463', 'IS464', 'IS467',
]);

function isRevenueLine(l: SectionLine): boolean {
  return REVENUE_CODES.has(l.code);
}

export async function generateIncomeStatement(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateIncomeStatement', { companyId, fiscalYear }, 'AfsPrimary');
  const { end: fyEnd } = await getFiscalRange(companyId, fiscalYear);
  const lines = rollUpTotals(await fetchSectionLines(companyId, 'income_statement', fiscalYear, fiscalYear - 1));
  const adjusted = lines.map((l) => (isRevenueLine(l) ? flipSign(l) : l));
  const blocks = renderHierarchicalTable(adjusted, true);
  return {
    dataSnapshot: { lines },
    content: {
      title: 'Statement of Profit or Loss',
      blocks: [
        { type: 'paragraph', text: `For the year ended ${fyEnd}.` },
        ...blocks,
      ],
    },
  };
}
