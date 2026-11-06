/** ADVERSARIAL REPRO (#1169 9cb2509c2): page 3 drops a block that master (#1158) keeps, and master's page 3
 *  with that block prints inside its sheet in Chromium (12/12 sheets, no overflow: adv1148-out/r7/pm-blk-*.txt).
 *  280 of the 284 such inputs on the 11,520 grid. */
import { expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from './fixtures/advInputs';

it('k=1, a loss, budget: Highlights keeps the three blocks master prints', () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const p3 = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: false, loss: true, k: 1, plug: 0, sg: [1, 1, -1, 1] })).pages.find((p) => p.navLabel === 'Highlights')!;
  expect(p3.blocks.length).toBe(3);
});
