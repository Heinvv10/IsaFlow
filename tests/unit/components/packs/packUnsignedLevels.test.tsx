/**
 * Runs under vitest.components.config.ts.
 *
 * A LEVEL IS UNSIGNED; ONLY A CHANGE TAKES "+".
 *
 * Page 12 says so, and the printed packs did otherwise: page 9's Gross margin
 * target read "+35.0%" on every board pack, and page 6's % of revenue column
 * "+100.0%", "+1 410.8%", "+223.7%", "+11.6%" — a share of revenue, not a
 * movement. A positive margin on page 3's tile or page 9's actual column
 * would have printed a "+" the same way.
 *
 * So, on every fixture's printed markup: the "+" percentages are exactly the
 * positive figures of the CHANGE % column, and no other.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { formatPct } from '@/lib/format/money';
import { brightsphereLiveInput, demoInput } from '../../services/packs/fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from '../../services/packs/fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  ['the live demo company, long window', liveDemoInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'");
const signed = (s: string) => (s.match(/\+[0-9][^%\s<]*(?:[\s  ][0-9][^%\s<]*)*%/g) ?? []).map((m) => m.replace(/[\s  ]/g, ' ')).sort();

describe('a level is unsigned, and only a change takes "+"', () => {
  it.each(FIXTURES)('%s', (_name, input) => {
    const document = buildBoardPackPages(input);
    const changes = document.pages.flatMap((page) => page.blocks.flatMap((block) => (block.kind === 'table' ? block.table.rows : [])))
      .flatMap((row) => (row.figures.changePct?.value ?? null) === null ? [] : [formatPct(row.figures.changePct!.value!, 1, { pack: true })])
      .filter((s) => s.startsWith('+')).map((s) => s.replace(/[\s  ]/g, ' ')).sort();
    const printed = signed(text(renderToStaticMarkup(<PackPagesView document={document} />)));
    expect(printed).toEqual(changes);
  });

  it('prints the gross-margin target unsigned', () => {
    const page = text(renderToStaticMarkup(<PackPagesView document={buildBoardPackPages(demoInput)} />));
    expect(page).toContain('35.0%');
    expect(page).not.toContain('+35.0%');
  });
});
