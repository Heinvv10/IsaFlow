/**
 * A ROW LABEL QUOTED IN PAGE 6'S PROSE, IN PRODUCTION'S IMAGE (#1261 adversarial H1): page 6's derived caption and its
 * "Lines below zero" disclosure quote the income statement's row labels, and the prose model (`packTextMetrics`) charged
 * U+FDFD 1em where production sets it at about 7.2em, so a label of them printed page 6 on a 13th sheet. The em model
 * now charges a character the faces do not set `FALLBACK_EMS`. Here the whole pack is composed with the first row
 * relabelled at source (the live Brightsphere pack, its prior-period twin and the demo), printed through the pack's
 * stylesheet in production's Chromium, and page 6 must fit its sheet (966px) or the pack be refused. Velo only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PRINT_CONTENT_HEIGHT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { brightsphereLiveInput, brightspherePriorInput, demoInput } from '../services/packs/fixtures/boardPackInputs';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';
import { paritySkip } from './paritySkip';

const relabel = vi.hoisted(() => ({ label: '' }));
vi.mock('@/modules/accounting/services/packs/pages/packStatementTables', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/packs/pages/packStatementTables')>();
  return {
    ...actual,
    buildIncomeStatementTable: (...args: Parameters<typeof actual.buildIncomeStatementTable>) => {
      const table = actual.buildIncomeStatementTable(...args);
      return relabel.label === '' ? table : { ...table, rows: table.rows.map((r, i) => (i === 0 ? { ...r, label: relabel.label, level: 2 as const } : r)) };
    },
  };
});

const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const words = (word: string, n: number): string => Array.from({ length: n }, () => word).join(' ');
/** The review's labels: a marked word, then runs of U+FDFD and of "%" (H1 and its M1 twin). */
const LABELS = [
  `Rent and \u0915\u093E\u093E ${words('\uFDFD\uFDFD', 6)} ${words('%%%%', 6)}`,
  `Rent and \u0915\u093E\u093E ${words('\uFDFD\uFDFD', 7)} ${words('%%%%', 3)}`,
  `Rent and \u0915\u093E\u093E ${words('\uFDFD\uFDFD', 7)} ${words('%%%%', 6)}`,
  `Rent and \u0915\u093E\u093E ${words('\uFDFD', 18)}`,
];
const PACKS: ReadonlyArray<readonly [string, BoardPackInput]> = [['brightsphere live', brightsphereLiveInput], ['brightsphere prior', brightspherePriorInput], ['demo', demoInput]];

const HEIGHTS = `function answer() {
  return Array.from(document.querySelectorAll('.pack-page')).map(function (pg) {
    var top = pg.getBoundingClientRect().top; var bottom = top;
    pg.querySelectorAll('*').forEach(function (e) { var b = e.getBoundingClientRect(); if (b.height > 0) bottom = Math.max(bottom, b.bottom); });
    return 'H|' + (bottom - top).toFixed(2);
  });
}`;

describe.skipIf(unavailable !== null)(`a row label quoted in page 6's prose, in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('the review\'s labels on the live Brightsphere pack, its prior-period twin and the demo: page 6 fits its sheet, or the pack is refused', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let printed = 0;
    try {
      for (const label of LABELS) {
        for (const [name, input] of PACKS) {
          relabel.label = label;
          let doc;
          try {
            doc = buildBoardPackPages(input);
          } catch (err) {
            if (err instanceof PackRefusal) continue;
            throw err;
          }
          const body = renderToStaticMarkup(createElement(PackPagesView, { document: doc as never }));
          const heights = (await inImage(gotenberg!, HEIGHTS, body)).filter((l) => l.startsWith('H|')).map((l) => Number(l.slice(2)));
          expect(heights.length, `${name}: the image's pages came back incomplete`).toBe(doc.pages.length);
          printed += 1;
          // Page 6, the income statement (portrait): the page that quotes the label.
          const index = doc.pages.findIndex((p) => p.navLabel === 'Income statement');
          expect(doc.pages[index]!.orientation).toBe('portrait');
          const px = heights[index]!;
          if (px > PRINT_CONTENT_HEIGHT_PX.portrait) wrong.push(`${name}, ${JSON.stringify(label).slice(0, 40)}: page 6 is ${px}px, past its ${PRINT_CONTENT_HEIGHT_PX.portrait}px sheet`);
        }
      }
    } finally {
      relabel.label = '';
      warn.mockRestore();
    }
    expect(printed).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  }, 1_800_000);
});
