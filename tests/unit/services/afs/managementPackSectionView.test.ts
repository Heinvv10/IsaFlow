/**
 * What a stored management pack section prints on every surface (PDF, DOCX, app, portal): its title
 * from the section vocabulary, never a bare key; a statement stored as JSON read as a table; no AI
 * failure sentence as commentary; and never a bare heading.
 */
import { describe, expect, it } from 'vitest';
import { packSectionView, type PackSectionInput } from '@/modules/accounting/services/afs/managementPackSectionView';
import {
  AI_COMMENTARY_UNAVAILABLE, AI_SUMMARY_UNAVAILABLE, EXECUTIVE_SUMMARY_MISSING, SECTIONS_META, SECTION_NOT_AVAILABLE,
  packSectionLabel,
} from '@/modules/accounting/services/afs/managementPackSections';

const sec = (sectionType: string, over: Partial<PackSectionInput> = {}): PackSectionInput => ({
  sectionType, content: { title: sectionType, blocks: [] }, aiNarrative: null, ...over,
});
const plain = (s: string) => s.replace(/ /g, ' ');

describe('titles come from SECTIONS_META', () => {
  it.each(SECTIONS_META.filter((m) => m.key !== 'cover').map((m) => [m.key, m.label]))('%s prints as %s', (key, label) => {
    expect(packSectionView(sec(key))?.title).toBe(label);
  });

  it('a stored title that is the bare key never reaches the page', () => {
    expect(packSectionView(sec('ai_executive_summary'))?.title).toBe('AI Executive Summary');
  });

  it('a key the vocabulary does not know is made readable rather than printed raw', () => {
    expect(packSectionLabel('some_new_section')).toBe('Some New Section');
  });

  it('an override title wins', () => {
    expect(packSectionView(sec('kpi_scorecard', { overrides: { title: 'Scorecard (revised)' } }))?.title).toBe('Scorecard (revised)');
  });
});

describe('the cover section', () => {
  it('is not printed: the pack has its own cover page', () => {
    expect(packSectionView(sec('cover'))).toBeNull();
    expect(packSectionView(sec('cover', { aiNarrative: 'commentary on a cover' }))).toBeNull();
  });
});

describe('a section with nothing in it says so', () => {
  it('prints a sentence, not a bare heading', () => {
    expect(packSectionView(sec('cash_flow'))?.blocks).toEqual([{ type: 'paragraph', text: SECTION_NOT_AVAILABLE }]);
  });

  it('the executive summary says it could not be generated', () => {
    expect(packSectionView(sec('ai_executive_summary'))?.blocks).toEqual([{ type: 'paragraph', text: EXECUTIVE_SUMMARY_MISSING }]);
  });

  it('prints no sentence when the section has a narrative of its own', () => {
    const v = packSectionView(sec('ai_executive_summary', { aiNarrative: 'Revenue grew.' }));
    expect(v?.blocks).toEqual([]);
    expect(v?.narrative).toBe('Revenue grew.');
  });

  it('a whitespace-only narrative is nothing', () => {
    expect(packSectionView(sec('debtors_ageing', { aiNarrative: '  ' }))?.narrative).toBeNull();
  });
});

describe('the AI failure sentences are not commentary', () => {
  it.each([AI_SUMMARY_UNAVAILABLE, AI_COMMENTARY_UNAVAILABLE])('%s', (text) => {
    const v = packSectionView(sec('kpi_scorecard', {
      content: { title: 'KPI Scorecard', blocks: [{ type: 'paragraph', text: 'x' }] }, aiNarrative: text,
    }));
    expect(v?.narrative).toBeNull();
  });
});

describe('a statement an older pack stored as JSON prints as a table', () => {
  it('income statement aggregate', () => {
    const v = packSectionView(sec('income_statement', {
      content: { title: 'Income Statement', blocks: [{ type: 'paragraph', text: '{"revenue":"120000.00","cogs":"0","net_profit":"44600.00"}' }] },
    }));
    const t = v?.blocks[0];
    expect(t?.type).toBe('table');
    if (t?.type !== 'table') throw new Error('not a table');
    expect(t.rows.map((r) => r.map(plain))).toEqual([['Revenue', 'R 120 000.00'], ['Cost of sales', 'R 0.00'], ['Net profit', 'R 44 600.00']]);
  });

  it('balance sheet snapshot', () => {
    const v = packSectionView(sec('balance_sheet', {
      content: { title: 'Balance Sheet', blocks: [{ type: 'paragraph', text: '{"currentAssets":44600,"currentLiabilities":0,"inventory":0,"tradeReceivables":0,"tradePayables":0,"totalDebt":0,"totalEquity":44600}' }] },
    }));
    const t = v?.blocks[0];
    if (t?.type !== 'table') throw new Error('not a table');
    expect(t.rows[0]?.map(plain)).toEqual(['Current assets', 'R 44 600.00']);
    expect(t.rows.map((r) => r[0])).toContain('Total equity');
  });

  it('a paragraph that is not a JSON object is left alone, and so is JSON in any other section', () => {
    const text = 'Revenue was R 10.';
    expect(packSectionView(sec('income_statement', { content: { blocks: [{ type: 'paragraph', text }] } }))?.blocks).toEqual([{ type: 'paragraph', text }]);
    const json = '{"revenue":"1"}';
    expect(packSectionView(sec('kpi_scorecard', { content: { blocks: [{ type: 'paragraph', text: json }] } }))?.blocks).toEqual([{ type: 'paragraph', text: json }]);
  });
});

describe('an accepted AI narrative is printed once', () => {
  // PUT .../ai-narrative freezes the narrative into overrides.blocks as a paragraph and leaves ai_narrative set.
  it('not again beneath the blocks that already carry it', () => {
    const v = packSectionView(sec('ai_executive_summary', {
      aiNarrative: 'Revenue grew.',
      overrides: { title: 'AI Executive Summary', blocks: [{ type: 'paragraph', text: 'Revenue grew.' }] },
    }));
    expect(v?.blocks).toEqual([{ type: 'paragraph', text: 'Revenue grew.' }]);
    expect(v?.narrative).toBeNull();
  });

  it('still prints a narrative the blocks do not carry', () => {
    const v = packSectionView(sec('kpi_scorecard', {
      aiNarrative: 'Margins fell.',
      overrides: { blocks: [{ type: 'paragraph', text: 'Edited by the accountant.' }] },
    }));
    expect(v?.narrative).toBe('Margins fell.');
  });
});
