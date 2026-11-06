/** ADVERSARIAL REPRO (#1169): at a small scale (figures at their 22pt ceiling) the new KPI ruler changes
 *  page 3's height model and the fitter now drops notes master printed -- and master's page fits in Chromium
 *  (vover=[] in adv1148-out/r4/printD-base.txt). */
import { expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from './fixtures/advInputs';

it('k=30, zero-revenue trend: Highlights prints what master printed (no omission note)', () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const p3 = buildBoardPackPages(input({ tr: 'zero', budget: true, prior: true, negative: true, loss: false, k: 30, plug: 0, sg: [1, 1, -1, 1] })).pages.find((p) => p.navLabel === 'Highlights')!;
  expect(p3.footnotes.find((f) => f.text.startsWith('Not printed'))?.text ?? null).toBeNull();
});
