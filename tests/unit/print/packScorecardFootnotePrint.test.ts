/**
 * Page 9 of a company with a comparative period but no trend panels, printed: its only footnote is
 * the prior-column note and it is numbered 1, on the footnote list and on every PRIOR heading
 * (the scorecard prints PRIOR five times, once per lettered group). The sheet is still inside its
 * paper.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from '../services/packs/fixtures/boardPackInputs';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe('the Scorecard sheet with only the prior-column note', () => {
  it('numbers it 1 everywhere, and fits its sheet', async () => {
    const doc = buildBoardPackPages({ ...demoInput, trend: [] });
    const idx = doc.pages.findIndex((p) => p.navLabel === 'Scorecard');
    const id = `pack-page-${idx + 1}`;
    expect(doc.pages[idx]!.footnotes.map((f) => f.number)).toEqual([1]);

    const markup = renderToStaticMarkup(createElement(PackPagesView, { document: doc }));
    const start = markup.indexOf(`id="${id}"`);
    const next = markup.indexOf('id="pack-page-', start + 1);
    const html = markup.slice(start, next === -1 ? undefined : next);
    const markers = [...html.matchAll(/class="pack-footnote-marker"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
    const listed = [...html.matchAll(/<span class="pack-footnote-number">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    expect(listed).toEqual([1]);
    expect(markers.length, 'one PRIOR superscript per lettered group').toBeGreaterThanOrEqual(1);
    expect(markers.every((n) => n === 1)).toBe(true);

    const printed = await printBoardPack(doc, browser);
    expect(printed.sheets).toBe(doc.pages.length);
    expect(printed.overflow.filter((o) => o.id === id)).toEqual([]);
    expect(printed.heights[idx]!.overMm).toBeLessThanOrEqual(0.2);
  }, 300_000);
});
