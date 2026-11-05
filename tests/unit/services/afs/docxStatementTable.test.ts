/**
 * A statement in the DOCX looks like the PDF's: the row kinds print bold (the bottom line shaded), and a column
 * is right-aligned because its cells are figures, not because its header spells an "R".
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import type { AfsDocument, AfsSection, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

const PACK = { id: 'd', companyId: 'co', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
const NB = ' ';
const STATEMENT: NoteContentBlock = {
  type: 'table', headers: ['', 'This month', 'Prior month'],
  rows: [['Revenue', '', ''], ['4100 Sales', `R${NB}250${NB}000.00`, `−R${NB}120${NB}000.00`], ['Total revenue', `R${NB}250${NB}000.00`, '—'], ['Net profit', `R${NB}250${NB}150.00`, `R${NB}44${NB}600.00`]],
  rowKinds: ['heading', 'line', 'subtotal', 'total'],
};
const section = (blocks: NoteContentBlock[]): AfsSection => ({
  id: 's', documentId: 'd', companyId: 'co', sectionType: 'income_statement', sortOrder: 0, status: 'x', dataSnapshot: null,
  content: { title: 'Income Statement', blocks }, overrides: null, aiNarrative: null, aiNarrativeAccepted: false,
} as unknown as AfsSection);
async function rows(blocks: NoteContentBlock[]): Promise<string[]> {
  const zip = await JSZip.loadAsync(await renderToDocx(PACK, [section(blocks)], 'Acme'));
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml.split('<w:tr>').slice(1);
}
const cellsOf = (row: string) => row.split('<w:tc>').slice(1);
const rowWith = (rs: string[], text: string) => rs.find((r) => r.includes(text)) ?? '';

describe('row kinds', () => {
  it('heading, subtotal and the bottom line are bold; an account line is not', async () => {
    const rs = await rows([STATEMENT]);
    const bold = (text: string) => cellsOf(rowWith(rs, text))[0]?.includes('<w:b/>');
    expect(bold('Revenue')).toBe(true);
    expect(bold('Total revenue')).toBe(true);
    expect(bold('Net profit')).toBe(true);
    expect(bold('4100 Sales')).toBe(false);
  });

  it('only the bottom line is shaded', async () => {
    const rs = await rows([STATEMENT]);
    expect(rowWith(rs, 'Net profit')).toContain('<w:shd');
    expect(rowWith(rs, '4100 Sales')).not.toContain('<w:shd');
    expect(rowWith(rs, 'Total revenue')).not.toContain('<w:shd');
  });

  it('an unknown or hostile kind is a plain row', async () => {
    const rs = await rows([{ ...STATEMENT, rowKinds: ['line', 'x"><b>', 5, 'constructor'] } as unknown as NoteContentBlock]);
    expect(rowWith(rs, 'Net profit')).not.toContain('<w:shd');
    expect(cellsOf(rowWith(rs, 'Net profit'))[0]).not.toContain('<w:b/>');
  });
});

describe('column alignment follows the cells', () => {
  it('both figure columns and the label column of a statement', async () => {
    const rs = await rows([STATEMENT]);
    const cells = cellsOf(rowWith(rs, '4100 Sales'));
    expect(cells[0]).not.toContain('w:jc w:val="right"');
    expect(cells[1]).toContain('w:jc w:val="right"');
    expect(cells[2]).toContain('w:jc w:val="right"');
  });

  it('a text column is left however its header is spelled, and a figure column right however its header is', async () => {
    const rs = await rows([{ type: 'table', headers: ['Result', 'Name'], rows: [['Favourable', '12.5'], ['Unfavourable', '7']] }]);
    const cells = cellsOf(rowWith(rs, 'Unfavourable'));
    expect(cells[0]).not.toContain('w:jc w:val="right"');
    expect(cells[1]).toContain('w:jc w:val="right"');
  });

  it('percentages, signed figures and dashes: a column of them is right-aligned', async () => {
    const rs = await rows([{ type: 'table', headers: ['A', 'Var %'], rows: [['x', '+50.0%'], ['y', '—'], ['z', '−100.0%']] }]);
    expect(cellsOf(rowWith(rs, '+50.0%'))[1]).toContain('w:jc w:val="right"');
  });
});
