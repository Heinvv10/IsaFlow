/**
 * Runs under vitest.components.config.ts.
 *
 * EVERY MULTIPLE ON THE BOARD PACK PRINTS WITH ×.
 *
 * Page 9 printed a current ratio of "(0.14)" against a target of "1.50" and a
 * debt-to-equity target of "0.50", and page 7 "a current ratio of (0.14)" —
 * bare numbers, where every other ratio surface (`ratioPresentation`) prints
 * "(0.14)× / 1.50×". The convention: two decimals, a negative bracketed with
 * the × outside.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput, demoInput } from '../../services/packs/fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from '../../services/packs/fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  ['the live demo company, long window', liveDemoInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

const clean = (s: string) => s.replace(/<[^>]*>/g, '').replace(/[  ]/g, ' ').trim();
/** A multiple, a dash, or a cell that is not a figure (n/m and its mark). */
const MULTIPLE = /^\(?\d[\d ]*\.\d{2}\)?×$/;

describe('every multiple on the board pack prints with ×', () => {
  it.each(FIXTURES)('page 9, actual, prior and target — %s', (_name, input) => {
    const document = buildBoardPackPages(input);
    const html = renderToStaticMarkup(<PackPagesView document={document} />);
    // A metric's first cell carries its footnote mark after the name.
    const printed = [...html.matchAll(/<tr class="pack-scorecard-row">(.*?)<\/tr>/g)]
      .map((row) => [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => clean(c[1]!)));
    const rows = document.pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []))
      .filter((row) => row.actual.format === 'ratio');
    expect(rows.length).toBeGreaterThan(0);
    let figures = 0;
    for (const row of rows) {
      const cells = printed.find((c) => c[0]!.replace(/\d+$/, '') === row.metric);
      expect(cells, `${row.metric} is not printed`).toBeDefined();
      const [, actual, target, prior] = cells!;
      const due: Array<[string, number | null | undefined, string]> = [
        ['actual', row.actual.value, actual!], ['target', row.target, target!], ['prior', row.prior?.value, prior!],
      ];
      for (const [column, value, text] of due) {
        if (value === null || value === undefined || value === 0) continue;
        figures += 1;
        expect(text, `${row.metric}'s ${column}`).toMatch(MULTIPLE);
      }
    }
    expect(figures).toBeGreaterThan(0);
  });

  it('page 7 states the current ratio as a multiple', () => {
    const html = clean(renderToStaticMarkup(<PackPagesView document={buildBoardPackPages(demoInput)} />));
    expect(html).toMatch(/a current ratio of \(?\d[\d ]*\.\d{2}\)?×/);
  });
});
