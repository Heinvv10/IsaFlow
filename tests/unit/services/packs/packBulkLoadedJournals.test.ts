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
    expect(loads[0]!.issue).toMatch(/^19\u00a0581 journals dated as far back as 1 April 2025 were recorded in bulk on 12 days between 5 September 2026 and 18 September 2026/);
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
