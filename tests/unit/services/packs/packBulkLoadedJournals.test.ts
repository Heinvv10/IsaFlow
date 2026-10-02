/**
 * PAGES 4 AND 11 SAY WHAT THE BACKDATING CHECK SKIPPED, AND COUNT LIKE THE
 * REST OF THE SHEET.
 *
 * Velocity Fibre's ledger was reloaded in September 2026 and its board pack
 * raised 19 588 "matters", almost all of them reloaded journals recorded after
 * their dates. The check now leaves a bulk load out (`BULK_LOAD_MIN`), and a
 * check that leaves something out has to say so where it reports: page 11's
 * "What was checked" and page 4, whose action panel is drawn from the same
 * checks. A pack with no bulk load says nothing about one.
 *
 * And a count is written the way every figure on the sheet is: page 4's title
 * read "4 of 19588 matters" over a quantum column reading "10 353".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { checkMattersCrossReference } from '@/modules/accounting/services/packs/figures/packMattersIntegrity';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { demoInput } from './fixtures/boardPackInputs';
import { velocityInput } from './fixtures/velocityBoardPack';

const RELOAD = { journals: 19_581, days: 12, firstRecorded: '2026-09-05', lastRecorded: '2026-09-18' };

const pageNamed = (doc: PackPagesDocument, nav: string): PackPage => {
  const page = doc.pages.find((p) => p.navLabel === nav);
  expect(page, `no page called ${nav}`).toBeDefined();
  return page!;
};

/** Every sentence a page prints in its disclosures. */
function notesOf(page: PackPage): string {
  return page.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => `${n.heading}: ${n.body}`) : []))
    .join('\n');
}

describe('a pack whose ledger was loaded in bulk', () => {
  let doc: PackPagesDocument;
  beforeEach(() => { doc = buildBoardPackPages({ ...velocityInput, bulkLoadedJournals: RELOAD }); });

  for (const nav of ['Commentary and actions', 'Matters for the board']) {
    it(`states on "${nav}" how many journals the late-recording test skipped, and when they were loaded`, () => {
      const notes = notesOf(pageNamed(doc, nav));
      expect(notes).toMatch(/19 581 journals recorded in bulk/);
      expect(notes).toContain('on 12 days between 5 September 2026 and 18 September 2026');
      expect(notes).toMatch(/not tested for late recording/);
      expect(notes).toMatch(/round-number test still covers them/);
    });
  }

  it('names the day itself where the load was one day', () => {
    const one = buildBoardPackPages({
      ...velocityInput,
      bulkLoadedJournals: { journals: 1, days: 1, firstRecorded: '2026-09-05', lastRecorded: '2026-09-05' },
    });
    expect(notesOf(pageNamed(one, 'Matters for the board'))).toContain('1 journal recorded in bulk on 5 September 2026');
  });
});

describe('a pack whose ledger was not', () => {
  it('says nothing about a bulk load on either page', () => {
    const doc = buildBoardPackPages({ ...velocityInput, bulkLoadedJournals: null });
    for (const nav of ['Commentary and actions', 'Matters for the board']) {
      expect(notesOf(pageNamed(doc, nav))).not.toMatch(/in bulk/);
    }
  });
});

describe('a count of matters in the thousands', () => {
  // 1 234 round-number journals, which the page cannot print all of.
  const many: PackMatter[] = Array.from({ length: 1_234 }, (_, i) => ({
    kind: 'finding',
    issue: `Journal JE-${i} (large round-number amount): transfer`,
    quantum: 1_000_000 + i * 1_000,
    owner: 'Finance',
    movement: 'Not tracked — no prior board pack is stored to compare against.',
    decisionRequired: BOARD_DECISIONS.unusualJournal,
  }));
  const input: BoardPackInput = { ...demoInput, matters: many };
  // Built inside each test: the integrity gate REFUSES a pack whose counts
  // it cannot read, and a refusal at collection time names no test.
  let doc: PackPagesDocument;
  beforeEach(() => { doc = buildBoardPackPages(input); });

  it('is grouped in both titles', () => {
    expect(pageNamed(doc, 'Commentary and actions').title).toMatch(/ of 1 234 matters requiring/);
    expect(pageNamed(doc, 'Matters for the board').title).toMatch(/^1 234 matters require a board decision, 1 234 of them/);
  });

  it('is grouped in the lines that say what is not printed', () => {
    const json = JSON.stringify(doc.pages);
    expect(json).not.toMatch(/\b\d{4,} further matters/);
    expect(json).toMatch(/\d\u00a0\d{3} further matters are not printed in this pack/);
  });

  it('is grouped where page 11\'s table prints it', () => {
    const table = pageNamed(doc, 'Matters for the board').blocks.find((b) => b.kind === 'matters');
    if (table === undefined || table.kind !== 'matters' || table.omitted === null) throw new Error('no omitted tail');
    expect(table.omitted.count).toBeGreaterThan(999);
    const html = renderToStaticMarkup(createElement(PackPagesView, { document: doc }));
    const grouped = table.omitted.count.toLocaleString('en-ZA').replace(/[\s\u202f]/g, '\u00a0');
    expect(html).toContain(`${grouped} further matters are not printed.`);
  });

  it('still reconciles: the integrity check reads a grouped count', () => {
    expect(checkMattersCrossReference(doc)).toEqual([]);
  });
});
