/**
 * PAGE 4'S HEADLINE NAMES A FIGURE. PAGE 4 HAS TO PRINT IT.
 *
 * Brightsphere's page 4 read "3 of 31 matters requiring a board decision are
 * put to the board on this page, the largest carrying 4 128 of exposure" over
 * an action panel whose largest printed figure was 4 146 — the aged-debtor
 * BASE, not an exposure at all. The headline was true: the debtor matter's
 * quantum is 3 192, and it is printed on page 11. But page 4 could not be
 * checked on its own, and the number that WAS on it pointed the other way.
 * The twelfth visual gate called it the most damaging defect in the pack,
 * and it surfaced only on the company with a debtor concentration.
 *
 * The pack's standard — the one three gates have praised it for — is that
 * every claim is checkable off the sheet that prints it. So the headline's
 * subject has to be on the sheet: this reads the figure back out of the
 * headline the way a director does, and looks for it in the panel below.
 *
 * It is asserted over the two fixtures that reach the branch, one of which
 * carries the debtor matter that made the number invisible. What that ROW
 * prints — its own exposure beside the base it is a share of — is held at the
 * source instead, in `packMatters.test.ts`: the fixtures here carry a COPY of
 * that sentence and would go on passing after the product stopped writing it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { demoInput } from './fixtures/boardPackInputs';

/** The action panel's bullets, as the sheet sets them. */
function actionPanel(input: BoardPackInput): { title: string; items: string[] } {
  const page = buildBoardPackPages(input).pages
    .find((p) => p.navLabel === 'Commentary and actions')!;
  const items = page.blocks
    .flatMap((b) => (b.kind === 'narrative' ? b.boardActions ?? [] : []));
  return { title: page.title, items };
}

describe('the figure page 4 headlines is printed on page 4', () => {
  for (const [name, input] of [
    ['the live demo pack', liveDemoRenderedInput],
    ['a pack carrying an aged-debtor concentration', demoInput],
  ] as const) {
    it(`prints the largest exposure it names — ${name}`, () => {
      const { title, items } = actionPanel(input);
      const stated = /the largest carrying (.+?) of exposure/.exec(title);
      expect(stated, `${name}: page 4 states no largest exposure`).not.toBeNull();
      expect(items.length, `${name}: the panel prints nothing`).toBeGreaterThan(0);

      const figure = stated![1]!;
      expect(items.join(' '), `${name}: page 4 headlines ${figure} and does not print it`)
        .toContain(figure);
    });
  }
});
