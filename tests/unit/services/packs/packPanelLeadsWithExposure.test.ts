/**
 * PAGE 4 LEADS WITH THE LARGEST EXPOSURE.
 *
 * The panel took page 11's print order — matters with no single rand amount
 * first — and on Velocity Fibre's pack that filled it with the bank backlog
 * and the bulk load, so the R10 353k debtor concentration, the largest
 * exposure on the books, reached page 11 only. Page 4 is the sheet a director
 * reads first. It now opens on the largest exposure, then the matters with
 * no single amount — the state of the book: a backlog, a reload — then the
 * other exposures. Page 11 keeps its own order, which its "not printed" total
 * depends on.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { boardActionMatters } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { velocityInput } from './fixtures/velocityBoardPack';

const pageNamed = (doc: PackPagesDocument, nav: string): PackPage => doc.pages.find((p) => p.navLabel === nav)!;

function panelItems(doc: PackPagesDocument): string[] {
  for (const block of pageNamed(doc, 'Commentary and actions').blocks) {
    if (block.kind === 'narrative' && block.boardActions !== undefined) return block.boardActions;
  }
  throw new Error('page 4 has no action panel');
}

describe('page 4\'s panel on Velocity Fibre\'s matters', () => {
  const doc = buildBoardPackPages(velocityInput);

  it('opens with the debtor concentration, the largest exposure, and still puts the reload before the board', () => {
    const items = panelItems(doc);
    expect(items[0]).toMatch(/^Aged debtor concentration: Herotel owes/);
    expect(items.some((i) => /recorded in bulk/.test(i))).toBe(true);
    expect(pageNamed(doc, 'Commentary and actions').title).toMatch(/the largest carrying 10.353 of exposure/);
  });

  it('keeps page 11 listing the matters with no single amount first', () => {
    const table = pageNamed(doc, 'Matters for the board').blocks.find((b) => b.kind === 'matters');
    if (table === undefined || table.kind !== 'matters') throw new Error('page 11 has no table');
    expect(table.matters[0]!.quantum.value).toBeNull();
  });
});

describe('the panel\'s order', () => {
  const matter = (issue: string, quantum: number | null): PackMatter => ({
    kind: 'finding', issue, quantum, owner: 'Finance', movement: 'x', decisionRequired: 'Whether.',
  });

  it('is the largest exposure, then the unquantified, then the other exposures', () => {
    const printed = [matter('none-a', null), matter('none-b', null), matter('big', 900), matter('small', 10)];
    expect(boardActionMatters({ printed, omitted: [], source: printed }).map((m) => m.issue))
      .toEqual(['big', 'none-a', 'none-b', 'small']);
  });

  it('is unchanged where nothing carries an amount', () => {
    const printed = [matter('a', null), matter('b', null)];
    expect(boardActionMatters({ printed, omitted: [], source: printed }).map((m) => m.issue)).toEqual(['a', 'b']);
  });
});

describe('page 11\'s "What was checked"', () => {
  it('says the round-number test skips postings generated from documents', () => {
    const page = pageNamed(buildBoardPackPages(velocityInput), 'Matters for the board');
    const sources = page.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
      .find((n) => n.heading === 'Sources');
    expect(sources?.body).toMatch(/Round numbers are not tested on postings generated from documents\./);
  });
});

