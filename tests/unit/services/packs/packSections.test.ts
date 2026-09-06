import { describe, it, expect } from 'vitest';
import { getPackTemplate } from '@/modules/accounting/services/reports/reportPackService';
import {
  packSectionTitle, isLandscapeSection, packPrintApiPaths, packTrendApiPath, PACK_DATA_API, PACK_LABELS,
} from '@/modules/accounting/services/packs/packSections';

describe('packSectionTitle', () => {
  it('uses the IFRS for SMEs names for the three primary statements', () => {
    expect(packSectionTitle('income_statement', 'Income Statement')).toBe('Statement of Comprehensive Income');
    expect(packSectionTitle('balance_sheet', 'Balance Sheet')).toBe('Statement of Financial Position');
    expect(packSectionTitle('cash_flow', 'Cash Flow')).toBe('Statement of Cash Flows');
  });

  it('has a title for EVERY section the pack service emits, on every pack type', () => {
    // A section added to reportPackService with no entry here would otherwise
    // print its plain-English screen label inside an IFRS document.
    for (const type of ['board', 'management', 'monthly'] as const) {
      for (const section of getPackTemplate(type)) {
        expect(packSectionTitle(section.type, '')).not.toBe('');
      }
    }
  });
});

describe('isLandscapeSection', () => {
  it('turns the two chart sections sideways and nothing else', () => {
    expect(isLandscapeSection('waterfall')).toBe(true);
    expect(isLandscapeSection('trends')).toBe(true);
    expect(isLandscapeSection('income_statement')).toBe(false);
    expect(isLandscapeSection('ratios')).toBe(false);
  });
});

describe('print API paths', () => {
  it('authorises the pack route and the pack-specific trend route, and nothing else', () => {
    expect(packPrintApiPaths('management')).toEqual([PACK_DATA_API, '/api/accounting/packs/management/trend']);
    expect(packTrendApiPath('board')).toBe('/api/accounting/packs/board/trend');
  });
  it('names all three packs', () => {
    expect(Object.keys(PACK_LABELS).sort()).toEqual(['board', 'management', 'monthly']);
  });
});
