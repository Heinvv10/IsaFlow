/**
 * A BULK LOAD IS ONE MATTER ON PAGES 4 AND 11, AND COUNTS ARE GROUPED.
 *
 * Velocity Fibre's ledger was reloaded in September 2026 and its board pack
 * raised 19 588 "matters", almost all reloaded journals recorded after their
 * dates. The backdating check no longer lists a bulk load journal by journal
 * (`BULK_LOAD_MIN`), and it does not drop it either: the load is ONE matter,
 * saying how many journals, on which days and how far back they are dated —
 * so a deliberately backdated journal recorded among routine ones still
 * reaches the board, as part of a load it is asked to rule on.
 *
 * And a count is written the way every figure on the sheet is: page 4's title
 * read "4 of 19588 matters" over a quantum column reading "10 353".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import { checkMattersCrossReference } from '@/modules/accounting/services/packs/figures/packMattersIntegrity';
import { boardActionItems, narrativeTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { groupedCount } from '@/modules/accounting/services/packs/pages/packMatterWords';
import { bulkLoadedMatter } from '@/modules/accounting/services/packs/pages/packBulkLoadedJournals';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { demoInput } from './fixtures/boardPackInputs';
import { velocityInput } from './fixtures/velocityBoardPack';

const pageNamed = (doc: PackPagesDocument, nav: string): PackPage => {
  const page = doc.pages.find((p) => p.navLabel === nav);
  expect(page, `no page called ${nav}`).toBeDefined();
  return page!;
};

describe('a pack whose ledger was loaded in bulk', () => {
  let doc: PackPagesDocument;
  beforeEach(() => { doc = buildBoardPackPages(velocityInput); });

  it('lists the load on page 11 as one row, among the matters with no single amount', () => {
    const table = pageNamed(doc, 'Matters for the board').blocks.find((b) => b.kind === 'matters');
    if (table === undefined || table.kind !== 'matters') throw new Error('page 11 has no table');
    const loads = table.matters.filter((m) => /recorded in bulk/.test(m.issue));
    expect(loads).toHaveLength(1);
    expect(loads[0]!.issue).toMatch(/^19\u00a0581 journals dated as far back as 1 January 2026 were recorded in bulk on 12 days between 5 September 2026 and 18 September 2026/);
    expect(loads[0]!.decisionRequired).toBe(BOARD_DECISIONS.bulkLoadedJournals);
  });

  it('puts the load before the board on page 4', () => {
    expect(JSON.stringify(pageNamed(doc, 'Commentary and actions').blocks)).toContain('recorded in bulk');
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

describe('the counts no whole pack reaches', () => {
  const finding = (i: number): PackMatter => ({
    kind: 'finding', issue: `Journal JE-${i} (large round-number amount): transfer`, quantum: 1_000_000,
    owner: 'Finance', movement: 'Not tracked.', decisionRequired: BOARD_DECISIONS.unusualJournal,
  });

  it('groups the "further matters follow on the matters page" count, which the gate also reads', () => {
    // Page 11 prints a handful of rows, so a real pack never has a thousand
    // follow on; the panel's own arithmetic is held here instead.
    const printed = Array.from({ length: 1_234 }, (_, i) => finding(i));
    const { tail } = boardActionItems({ printed, omitted: [], source: printed });
    const followOn = tail.find((t) => t.includes('follow on the matters page'));
    expect(followOn).toMatch(/^1\u00a02\d\d further matters follow on the matters page\.$/);
  });

  it('writes a count of nothing as the digit, not the dash a measured nil takes', () => {
    expect(groupedCount(0)).toBe('0');
    // Page 4's title where the panel names no finding but the pack raises some.
    const none: PackMatter = { ...finding(0), kind: 'checkFailed', issue: 'aged debtors could not be assessed' };
    expect(narrativeTitle([none], [none, finding(1), finding(2)], PACK_SCALE))
      .toMatch(/^0 of 2 matters requiring a board decision are put to the board on this page/);
  });
});

describe('a load recorded on one day', () => {
  it('names the day, and says "that day" rather than "each of those days"', () => {
    const matter = bulkLoadedMatter({
      journals: 1, days: 1, firstRecorded: '2026-09-05', lastRecorded: '2026-09-05', oldestEntryDate: '2026-03-31',
    }, 'Not tracked.');
    expect(matter.issue).toBe('1 journal dated as far back as 31 March 2026 was recorded in bulk on 5 September 2026: '
      + '10 or more journals dated over 5 days earlier were recorded on that day, so none is listed here one by one '
      + 'for late recording.');
  });
});

