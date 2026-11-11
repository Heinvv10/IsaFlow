/**
 * EVERY PROSE TEXT A COMPOSED PACK PRINTS SETS ITS DICTIONARY-SCRIPT RUNS IN A `.pack-dictionary` SPAN (#1263 round 3,
 * the blind review's L2). The page model fills such a run grapheme by grapheme because the print breaks it anywhere,
 * which it does only inside the span (`PackProse.proseText`). So a composed pack's prose (titles, chart and panel
 * titles, footnotes, disclosures, definitions, the commentary and its actions, the matters, the contents, the scorecard
 * headings, the n/m reasons) is given a Thai run in every string, rendered by the app's own components into the print
 * Chromium, and each text node holding it must sit inside the span. The eyebrow is the page's fixed name, charged one
 * line, and is not prose.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { denseInput } from '../services/packs/fixtures/boardPackInputs';
import { launchPrintChromium } from './printChromium';

const THAI = 'การเงิน';
const PROSE_KEYS = new Set(['title', 'text', 'body', 'heading', 'issue', 'owner', 'movement', 'decisionRequired', 'definition', 'term',
  'reconciliationNote', 'name', 'navLabel', 'reason']);
const LIST_KEYS = new Set(['actions', 'boardActionsTail']);
/** The prose blocks the census must reach, by class. */
const BLOCKS = ['pack-title', 'pack-chart-title', 'pack-disclosure-heading', 'pack-disclosure-body', 'pack-definition-term',
  'pack-definition-body', 'pack-narrative-body', 'pack-contents-title', 'pack-footnotes', 'pack-matters', 'pack-scorecard-heading'];

/** `value` with a Thai run appended to every prose string in it. */
function marked(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return PROSE_KEYS.has(key) ? `${value} ${THAI}` : value;
  if (Array.isArray(value)) return value.map((v) => (LIST_KEYS.has(key) && typeof v === 'string' ? `${v} ${THAI}` : marked(v)));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, marked(v, k)]));
  return value;
}

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe('the prose a pack prints', () => {
  it('sets each dictionary-script run inside a .pack-dictionary span, in every kind of prose block', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let html: string;
    try {
      const doc = buildBoardPackPages({ ...denseInput, commentary: { status: 'approved', body: 'Revenue grew.', actions: ['Approve the facility.'] } });
      html = renderToStaticMarkup(createElement(PackPagesView, { document: marked(doc) as typeof doc }));
    } finally {
      warn.mockRestore();
    }
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
      const { outside, reached } = await page.evaluate((blocks) => {
        const out: string[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (!/[ก-๛]/u.test(node.textContent ?? '')) continue;
          const el = node.parentElement!;
          if (el.closest('.pack-dictionary') === null && el.closest('.pack-page-name') === null) out.push((node.textContent ?? '').slice(0, 60));
        }
        return { outside: out, reached: blocks.filter((cls) => document.querySelector(`.${cls} .pack-dictionary`) !== null) };
      }, BLOCKS);
      expect(outside.slice(0, 5)).toEqual([]);
      expect(BLOCKS.filter((cls) => !reached.includes(cls))).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);
});
