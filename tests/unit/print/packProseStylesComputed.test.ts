/**
 * THE PROSE MODEL'S STYLES ARE THE ONES THE PRINT COMPUTES (#1263 L3). `packProseStyles.test.ts` reads the rules each
 * `PROSE` entry names; a later or more specific rule (a `.pack-matters td { font-size: ... }`) would change what prints
 * and leave those rules, and that test, untouched. This renders the fixture packs as the app does, in the print
 * Chromium over the print stylesheet, and reads the computed size and weight of the element each style's text is set
 * in, wherever the packs print one. Every style must be found in some fixture, but the landscape title: no page prints
 * landscape (`packFitterAnchorsSweep.test.ts`).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { brightsphereInput, demoInput, denseInput } from '../services/packs/fixtures/boardPackInputs';
import { liveDemoApprovedCommentaryInput, liveDemoBridgeInput } from '../services/packs/fixtures/liveDemoBoardPack';
import { velocityInput } from '../services/packs/fixtures/velocityBoardPack';
import { launchPrintChromium } from './printChromium';
import { printStylesheet } from './renderPackPdf';

/** The element each style's text is set in, as `PackPagesView` renders it. */
const TEXT_OF: Readonly<Record<keyof typeof PROSE, string>> = {
  title: '.pack-page:not([data-print-landscape]) .pack-title',
  titleLandscape: '.pack-page[data-print-landscape] .pack-title',
  chartTitle: '.pack-chart-title:not(.pack-small-multiples .pack-chart-title)',
  panelTitle: '.pack-small-multiples .pack-chart-title',
  narrativeBody: '.pack-narrative-body',
  actionItem: '.pack-narrative-actions li',
  actionsTail: '.pack-narrative-actions-tail',
  disclosureHeading: '.pack-disclosure-heading',
  disclosureBody: '.pack-disclosure:not(.is-two-column) .pack-disclosure-body',
  disclosureBodyTwoColumn: '.pack-disclosure.is-two-column .pack-disclosure-body',
  disclosureNoteHeading: '.pack-disclosure:not(.is-two-column) .pack-disclosure-note-heading',
  disclosureNoteHeadingTwoColumn: '.pack-disclosure.is-two-column .pack-disclosure-note-heading',
  footnote: '.pack-footnotes li > span:not(.pack-footnote-number)',
  tableNote: '.pack-table-notes dd',
  tableNoteLabel: '.pack-table-notes dt',
  bridgeNote: '.pack-definition-bridge-note',
  definition: '.pack-definition-body',
  definitionTerm: '.pack-definition-term',
  scorecardHeading: '.pack-scorecard-heading',
  tableLabel: '.pack-scorecard-row td:first-child',
  mattersCell: '.pack-matters-row td:first-child',
  contents: '.pack-contents-title',
};
const MAY_BE_ABSENT = new Set<keyof typeof PROSE>(['titleLandscape']);

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

describe('the prose styles, as the print computes them', () => {
  it('every element a style\'s text is set in has the style\'s size and weight', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let body: string;
    try {
      body = [demoInput, denseInput, brightsphereInput, velocityInput, liveDemoBridgeInput, liveDemoApprovedCommentaryInput]
        .map((input) => renderToStaticMarkup(createElement(PackPagesView, { document: buildBoardPackPages(input) }))).join('');
    } finally {
      warn.mockRestore();
    }
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html class="print-mode"><head><meta charset="utf-8"><style>${printStylesheet()}</style></head><body>${body}</body></html>`);
      const seen = await page.evaluate((selectors) => Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name,
        Array.from(document.querySelectorAll(selector)).map((el) => { const cs = getComputedStyle(el); return `${cs.fontSize} ${cs.fontWeight}`; })])), TEXT_OF);
      const wrong: string[] = [];
      for (const [name, style] of Object.entries(PROSE) as Array<[keyof typeof PROSE, (typeof PROSE)[keyof typeof PROSE]]>) {
        const found = seen[name] ?? [];
        if (found.length === 0 && !MAY_BE_ABSENT.has(name)) wrong.push(`${name}: no ${TEXT_OF[name]} in the fixture packs`);
        const want = `${Number(((style.pt * 96) / 72).toFixed(4))}px ${style.weight}`;
        for (const got of new Set(found)) {
          const [size, weight] = got.split(' ');
          if (Math.abs(Number.parseFloat(size!) - (style.pt * 96) / 72) > 0.01 || weight !== String(style.weight)) wrong.push(`${name}: ${got}, the model ${want}`);
        }
      }
      expect(wrong).toEqual([]);
    } finally {
      await page.close();
    }
  }, 300_000);
});
