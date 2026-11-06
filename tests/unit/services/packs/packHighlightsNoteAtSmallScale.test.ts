/**
 * AT A SMALL SCALE (figures at their 22pt ceiling) PAGE 3 KEEPS THE NOTES MASTER'S MODEL KEPT: the figure fit
 * must not change page 3's height model, which printed these packs inside the sheet.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { input } from './fixtures/packGridInputs';

afterEach(() => { vi.restoreAllMocks(); });

it('k=30, zero-revenue trend: Highlights prints what master printed (no omission note)', () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const p3 = buildBoardPackPages(input({ tr: 'zero', budget: true, prior: true, negative: true, loss: false, k: 30, plug: 0, sg: [1, 1, -1, 1] })).pages.find((p) => p.navLabel === 'Highlights')!;
  expect(p3.footnotes.find((f) => f.text.startsWith('Not printed'))?.text ?? null).toBeNull();
});
