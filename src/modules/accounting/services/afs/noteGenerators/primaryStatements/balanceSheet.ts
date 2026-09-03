// Statement of Financial Position (Balance Sheet) generator.
//
// Assets are debit-positive in the GL; liabilities + equity are
// credit-positive (DR-CR < 0). Sign-flip the L+E branches so they
// render as positive numbers on the BS. Branch detection uses the
// canonical catalogue's section structure: BS001-BS038 are assets;
// BS040 onward are equity & liabilities. (Catalogue source:
// afsMappingService.ts BS_LINES, lines 493-570.)

import { log } from '@/lib/logger';
import type { NoteContent, ReportingFramework } from '@/modules/accounting/services/afs/afsTypes';
import { fetchSectionLines, rollUpTotals, renderHierarchicalTable, flipSign, type SectionLine } from './_helpers';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';

// Asset codes from the canonical catalogue. Anything not in this set
// (and on the BS) is treated as equity or liability and sign-flipped.
const ASSET_CODES = new Set([
  'BS001', 'BS002', 'BS003', 'BS004', 'BS005', 'BS006', 'BS007', 'BS008', 'BS009', 'BS010',
  'BS011', 'BS012', 'BS013', 'BS014', 'BS015', 'BS016', 'BS017', 'BS018', 'BS019', 'BS020',
  'BS021', 'BS023', 'BS025', 'BS026', 'BS027', 'BS028', 'BS029', 'BS031', 'BS032',
  'BS035', 'BS036', 'BS037', 'BS038',
]);

function isAssetLine(l: SectionLine): boolean {
  return ASSET_CODES.has(l.code);
}

export async function generateStatementOfFinancialPosition(
  companyId: string,
  fiscalYear: number,
  _framework: ReportingFramework,
): Promise<{ dataSnapshot: Record<string, unknown>; content: NoteContent }> {
  log.info('generateStatementOfFinancialPosition', { companyId, fiscalYear }, 'AfsPrimary');
  const { end: fyEnd } = await getFiscalRange(companyId, fiscalYear);
  const lines = rollUpTotals(await fetchSectionLines(companyId, 'balance_sheet', fiscalYear, fiscalYear - 1));
  const adjusted = lines.map((l) => (isAssetLine(l) ? l : flipSign(l)));
  const blocks = renderHierarchicalTable(adjusted, true);
  return {
    dataSnapshot: { lines },
    content: {
      title: 'Statement of Financial Position',
      blocks: [
        { type: 'paragraph', text: `As at ${fyEnd}.` },
        ...blocks,
      ],
    },
  };
}
