/**
 * ONE DESIGNED DOCUMENT, NOT AN ASSEMBLY.
 *
 * Sheets 3 and 5 printed the SAME five-tile component: Revenue, Gross margin,
 * Operating profit, Net profit and Cash, the same objects in the same
 * component with the same sparklines, two pages apart, with nothing added on
 * the second showing. Sheet 5's own table then repeated four of the five a
 * third time, there with a comparative the tiles could not carry.
 *
 * A reader meeting a component twice reads the second as a mistake or as a
 * page they have already read; either way the pack stops looking composed.
 * The two pages now have one job each — page 3 is the tile page, page 5 the
 * statement page — and this is what stops the shortcut coming back, because
 * `tiles.slice(0, 5)` is a one-line edit away at any time.
 *
 * Only FIGURE-BEARING blocks are compared. Prose deliberately recurs: two
 * pages can both need the unexplained-plug disclosure, and both should make
 * it rather than cross-reference each other.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput, brightsphereInput } from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * What a figure block PRINTS, as one signature per thing a reader can point
 * at — nothing for a block that carries no figures and is allowed to recur.
 *
 * A TILE STRIP IS SIGNED TILE BY TILE, not as a strip. Page 3 draws eight
 * tiles and page 5 drew the first five of them; signing the strips whole
 * makes those two different objects and passes the exact defect this test
 * exists for. What a reader meets twice is the tile.
 *
 * Charts are keyed by their drawn geometry rather than by `id`, so two charts
 * given different ids but drawing one picture are still caught.
 */
function figureSignatures(block: PackPageBlock): string[] {
  switch (block.kind) {
    case 'kpiTiles':
      return block.tiles.map((t) => 'tile:' + JSON.stringify([t.label, t.value, t.delta]));
    case 'table':
      return ['table:' + JSON.stringify(block.table.rows.map((r) => [r.label, r.actual, r.prior]))];
    case 'chart':
      return ['chart:' + JSON.stringify([block.chart.kind, block.chart.title, block.chart.waterfallBars ?? null])];
    case 'scorecard':
      return ['scorecard:' + JSON.stringify(block.groups.map((g) => g.title))];
    default:
      return [];
  }
}

const PACKS = [
  ['the live demo company', liveDemoInput],
  ['the demo company', demoInput],
  ['Brightsphere', brightsphereInput],
] as const;

describe('a board pack prints no figure component twice', () => {
  for (const [company, input] of PACKS) {
    it(`gives every figure block on ${company}'s pack one home`, () => {
      const seen = new Map<string, number>();
      const compared = new Map<PackPageBlock['kind'], number>();

      for (const page of buildBoardPackPages(input).pages) {
        for (const block of page.blocks) {
          for (const signature of figureSignatures(block)) {
            compared.set(block.kind, (compared.get(block.kind) ?? 0) + 1);
            const first = seen.get(signature);
            expect(
              first,
              `page ${page.number} reprints a ${block.kind} component page ${first} already `
                + `carries, unchanged — ${signature}. Decide what each page is for and make `
                + 'them differ, or merge them.',
            ).toBeUndefined();
            seen.set(signature, page.number);
          }
        }
      }

      // NOT VACUOUS, PER KIND. The floor was one number over every kind at
      // once — `compared > 4` — and the tables, charts and scorecards alone
      // clear it, so deleting the `kpiTiles` arm of `figureSignatures`
      // altogether left the guard green while the one component the file
      // exists to protect went unsigned. Each arm now has to have run.
      expect(
        [...compared.entries()].filter(([, n]) => n > 0).map(([kind]) => kind).sort(),
        'a kind of figure block was signed by nothing, so this pack was not compared on it',
      ).toEqual(['chart', 'kpiTiles', 'scorecard', 'table']);
      // And the tile strip is signed TILE BY TILE — one signature for the
      // whole strip is the shape that made pages 3 and 5 different objects.
      expect(compared.get('kpiTiles') ?? 0, 'the tile strip was signed as one object')
        .toBeGreaterThan(4);
    });
  }
});
