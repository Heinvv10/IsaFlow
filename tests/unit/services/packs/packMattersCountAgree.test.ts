/**
 * PAGES 4 AND 11 COUNT THE SAME THING.
 *
 * Page 11's title counts FINDINGS. Page 4's counted every row of the
 * selection — so the "every check ran clean" line, which is a `PackMatter` of
 * kind `none`, made page 4 read "1 of 1 matters requiring a board decision is
 * put to the board on this page" two sheets before a page titled "0 matters
 * require a board decision this period". A failed check is the same shape:
 * page 11 says none requires a decision and that one check could not be run.
 *
 * Composed and read off the document, both kinds.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { BOARD_DECISIONS } from '@/modules/accounting/services/packs/pages/packMatterDecisions';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './fixtures/boardPackInputs';

const MOVEMENT = 'Not tracked — no prior board pack is stored to compare against.';

/** The two rows `buildMatters` writes that are not findings, as it writes them. */
const CLEAN: PackMatter = {
  kind: 'none',
  issue: 'No matters require board attention this period — every check ran clean.',
  quantum: null,
  owner: 'Finance',
  movement: MOVEMENT,
  decisionRequired: 'None. Note for the record.',
};
const FAILED: PackMatter = {
  kind: 'checkFailed',
  issue: 'Aged debtors could not be assessed — the check failed and was not silently skipped',
  quantum: null,
  owner: 'Finance',
  movement: MOVEMENT,
  decisionRequired: BOARD_DECISIONS.checkFailed,
};

const withMatters = (matters: PackMatter[]): BoardPackInput => ({ ...demoInput, matters });

function sheets(doc: PackPagesDocument): { page4: string; panel: string[]; page11: string } {
  const page4 = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'narrative' && b.boardActions !== undefined))!;
  const page11 = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'matters'))!;
  const narrative = page4.blocks.find((b) => b.kind === 'narrative');
  const panel = narrative?.kind === 'narrative' ? narrative.boardActions ?? [] : [];
  return { page4: page4.title, panel, page11: page11.title };
}

/** The number of matters a title says require a board decision. */
function decisionsClaimed(title: string): number {
  const of = /of (\d+) matters requiring a board decision/.exec(title);
  const bare = /^(\d+) matters? requires? a board decision/.exec(title);
  const found = of ?? bare;
  expect(found, `this title states no count: ${title}`).not.toBeNull();
  return Number(found![1]);
}

describe('page 4 and page 11 agree on how many matters require a decision', () => {
  it.each([
    ['only the "every check ran clean" line', [CLEAN], 0],
    ['only a check that could not be run', [FAILED], 0],
    ['a finding beside a failed check', [demoInput.matters[0]!, FAILED], 1],
    ['findings alone', demoInput.matters, demoInput.matters.length],
  ])('on a pack carrying %s', (_name, matters, findings) => {
    const { page4, page11 } = sheets(buildBoardPackPages(withMatters(matters as PackMatter[])));
    expect(decisionsClaimed(page11)).toBe(findings);
    expect(decisionsClaimed(page4), `page 4: "${page4}" / page 11: "${page11}"`).toBe(findings);
  });

  it('keeps the "every check ran clean" line on the panel, and does not count it', () => {
    // §7.1 criterion 3: a clean period is STATED. The line stays where the
    // board reads it; what changed is that the title no longer calls it one
    // of the matters requiring a decision.
    const { page4, panel } = sheets(buildBoardPackPages(withMatters([CLEAN])));
    expect(panel.join(' ')).toContain('every check ran clean');
    expect(page4).toMatch(/^0 matters require a board decision/);
  });

  it('still puts a failed check on the panel — it is a decision, to re-run it or not', () => {
    const { page4, panel } = sheets(buildBoardPackPages(withMatters([FAILED])));
    expect(panel.join(' ')).toContain('could not be assessed');
    expect(page4).toMatch(/could not be run/);
  });
});

describe('the gate refuses the two pages disagreeing', () => {
  it('refuses a page 4 that counts a matter page 11 does not', () => {
    const doc = buildBoardPackPages(withMatters([CLEAN]));
    const forged: PackPagesDocument = {
      ...doc,
      pages: doc.pages.map((p) => (p.blocks.some((b) => b.kind === 'narrative' && b.boardActions !== undefined)
        ? { ...p, title: '1 of 1 matters requiring a board decision is put to the board on this page; none of them carries a single rand amount.' }
        : p)),
    };
    expect(() => assertPackIntegrity(forged)).toThrow(/says 1 matter requires a board decision and page \d+ says 0/);
  });

  it('refuses a page 4 title that states no count at all, rather than skipping it', () => {
    const doc = buildBoardPackPages(withMatters([CLEAN]));
    const forged: PackPagesDocument = {
      ...doc,
      pages: doc.pages.map((p) => (p.blocks.some((b) => b.kind === 'narrative' && b.boardActions !== undefined)
        ? { ...p, title: 'Net profit of 512 for the period.' }
        : p)),
    };
    expect(() => assertPackIntegrity(forged)).toThrow(/does not state how many matters/);
  });

  it('accepts the document as composed', () => {
    expect(() => assertPackIntegrity(buildBoardPackPages(withMatters([CLEAN])))).not.toThrow();
    expect(() => assertPackIntegrity(buildBoardPackPages(withMatters([FAILED])))).not.toThrow();
  });
});
