/**
 * PAGE 3 KEEPS THE THREE BLOCKS THE #1158 HEIGHT MODEL KEPT (k=1, a loss, budget): printed in Chromium on master
 * inside its sheet, so dropping one is dropping a block that fits.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from './fixtures/packGridInputs';

afterEach(() => { vi.restoreAllMocks(); });

it('k=1, a loss, budget: Highlights keeps the three blocks master prints', () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const p3 = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: false, loss: true, k: 1, plug: 0, sg: [1, 1, -1, 1] })).pages.find((p) => p.navLabel === 'Highlights')!;
  expect(p3.blocks.length).toBe(3);
});
