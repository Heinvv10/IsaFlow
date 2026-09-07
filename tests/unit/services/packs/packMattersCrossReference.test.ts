/**
 * THE TWO PAGES THAT TALK ABOUT THE MATTERS MUST AGREE.
 *
 * On the rendered pack, sheet 4 said "23 further matters follow on the
 * matters page" and sheet 11 printed six, disclosing twenty-two that follow
 * nowhere; sheet 4 named JE-2026-00002 as a top matter and sheet 11 did not
 * carry it. Both pages were internally correct — they were two derivations of
 * one quantity, and the page that changed was not the page that lied.
 *
 * These read the COMPOSED document, which is what a director receives, and
 * they are written against the live demo company's twenty-eight matters
 * because that is the shape the contradiction needed.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { checkMattersCrossReference } from '@/modules/accounting/services/packs/figures/packBlockIntegrity';
import { selectPrintedMatters } from '@/modules/accounting/services/packs/pages/packMattersPrinted';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { liveDemoInput, liveDemoMatters } from './fixtures/liveDemoBoardPack';

function panelAndTable(doc: PackPagesDocument) {
  const blocks = doc.pages.flatMap((page) => page.blocks);
  const table = blocks.find((b) => b.kind === 'matters');
  const panel = blocks.find((b) => b.kind === 'narrative' && b.boardActions !== undefined);
  if (table?.kind !== 'matters') throw new Error('no matters block');
  if (panel?.kind !== 'narrative' || panel.boardActions === undefined) throw new Error('no action panel');
  return { table, actions: panel.boardActions };
}

describe('the matters selection', () => {
  it('prints matters with no rand amount first, then by exposure', () => {
    const { printed } = selectPrintedMatters(liveDemoMatters);
    const quanta = printed.map((m) => m.quantum);

    // The two AFS filings are the fixture's only null-quantum matters, and
    // they printed FIFTH and SIXTH — a 739-day-overdue statutory filing
    // ranked below four identical payroll journals, under a note saying it
    // would not be.
    expect(quanta.slice(0, 2)).toEqual([null, null]);
    expect(quanta.slice(2).every((q) => q !== null)).toBe(true);
    const amounts = quanta.slice(2) as number[];
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });

  it('keeps the provenance rank on the source order, not the printing order', () => {
    const { source } = selectPrintedMatters(liveDemoMatters);
    expect(source).toEqual(liveDemoMatters);
  });
});

describe('page 4 and page 11, on the composed document', () => {
  const doc = buildBoardPackPages(liveDemoInput);
  const { table, actions } = panelAndTable(doc);

  it('names only matters the matters page lists', () => {
    const printed = table.matters.map((m) => m.issue);
    const named = actions.filter((item) => !/^(\d+ further|Each of these)/.test(item));

    expect(named.length).toBeGreaterThan(0);
    for (const item of named) {
      expect(
        printed.some((issue) => item === issue || item.startsWith(`${issue} — `)),
        `the action panel names a matter the matters page does not list: "${item}"`,
      ).toBe(true);
    }
  });

  it('states the remainder from the matters page\'s own two arrays', () => {
    const named = actions.filter((item) => !/^(\d+ further|Each of these)/.test(item)).length;
    const follows = actions.find((i) => /further matters? follows? on the matters page/.test(i));
    const omitted = actions.find((i) => /not printed in this pack/.test(i));

    const rest = table.matters.length - named;
    // Nothing at all when the panel already names every printed matter: "0
    // further matters follow on the matters page" is a sentence about
    // nothing, and the cross-reference gate reads the ABSENCE of the line as
    // a remainder of zero.
    expect(follows).toBe(
      rest === 0
        ? undefined
        : rest === 1
          ? '1 further matter follows on the matters page.'
          : `${rest} further matters follow on the matters page.`,
    );
    expect(omitted).toContain(`${table.omitted?.count} further matters are not printed in this pack`);
  });

  it('composes at all — the gate runs on every pack', () => {
    expect(checkMattersCrossReference(doc)).toEqual([]);
  });
});

describe('the compose-time gate', () => {
  /** A document shaped like the one that shipped: the panel names a matter
   *  the table does not carry, and counts a remainder of its own. */
  function contradicting(actions: string[], printed: PackMatter[], omittedCount: number): PackPagesDocument {
    return {
      pages: [{
        blocks: [
          {
            kind: 'matters',
            matters: printed.map((m) => ({ ...m, quantum: { value: m.quantum } })),
            omitted: omittedCount === 0 ? null : { count: omittedCount, quantum: { value: 1 } },
          },
          { kind: 'narrative', narrative: { status: 'pending', body: null, actions: [] }, boardActions: actions },
        ],
      }],
    } as unknown as PackPagesDocument;
  }
  const one: PackMatter = {
    issue: 'Journal JE-2026-00001 (recorded well after its entry date)',
    quantum: 1000,
    owner: 'Finance',
    movement: 'Not tracked',
    decisionRequired: 'Confirm the entry',
  };

  it('refuses a panel that names a matter the matters page does not list', () => {
    const failures = checkMattersCrossReference(
      contradicting([one.issue, 'Journal JE-2026-00002 (recorded well after its entry date)'], [one], 0),
    );
    expect(failures.join(' ')).toContain('JE-2026-00002');
  });

  it('refuses a panel whose "further matters" count is not the matters page\'s', () => {
    const printed = [one, { ...one, issue: 'Second matter', quantum: 900 }];
    const failures = checkMattersCrossReference(
      contradicting([one.issue, '23 further matters follow on the matters page.'], printed, 0),
    );
    expect(failures.join(' ')).toContain('that page lists 2 and the panel names 1');
  });

  it('refuses a panel silent about matters the matters page says are missing', () => {
    const failures = checkMattersCrossReference(contradicting([one.issue], [one], 22));
    expect(failures.join(' ')).toContain('the matters page discloses 22');
  });
});
