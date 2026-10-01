/**
 * AN INTEGRITY REFUSAL IS A `PackRefusal`, AND IT TELLS THE READER WHICH CHECK.
 *
 * `assertPackIntegrity` threw a plain `Error`. The PDF route answers a
 * `PackRefusal` with a 422 carrying its `userMessage` and anything else with
 * a 500 and a fixed sentence — so a pack refused because its balance sheet is
 * out by R450 told the person who asked for it "This pack could not be built",
 * which is the one refusal in the system whose reason they can act on.
 *
 * Two audiences, as `PackRefusal` already separates them: the diagnostic keeps
 * every failure in full, source paths included; the reader's sentence names
 * the check that failed and carries no internal identifier.
 */
import { describe, expect, it } from 'vitest';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage, PackPageBlock, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput, outOfBalanceInput } from './fixtures/boardPackInputs';

const clean = buildBoardPackPages(demoInput);

/** What a thrown value is, or fail: every case below must be a refusal. */
function refusalOf(run: () => void): PackRefusal {
  let thrown: unknown = null;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown, 'nothing was refused').not.toBeNull();
  expect(thrown, `refused with a bare ${(thrown as Error).name}, which the route answers with a 500`)
    .toBeInstanceOf(PackRefusal);
  return thrown as PackRefusal;
}

/**
 * Anything a reader should not be shown: a provenance source path, a
 * function or module name, a block id, a spec clause, a code quote.
 */
const INTERNAL = [
  /\b[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]/,   // packFigureSet.current.totalAssets
  /\bpack[A-Z]\w+/,                     // packStatementTables
  /\b[a-z]+[A-Z]\w*\b/,                 // camelCase: checkBlocks, waterfallBars
  /'[a-z]+(?:-[a-z]+)+'/,               // 'cash-bridge'
  /spec §|§\d/,
  /`/,
];

function expectReadable(message: string): void {
  for (const pattern of INTERNAL) {
    expect(message, `the reader's sentence carries ${pattern}`).not.toMatch(pattern);
  }
  expect(message).toMatch(/has not been produced/);
}

const mapPages = (change: (page: PackPage) => PackPage): PackPagesDocument =>
  ({ ...clean, pages: clean.pages.map(change) });

const mapBlocks = (change: (block: PackPageBlock, page: PackPage) => PackPageBlock): PackPagesDocument =>
  mapPages((page) => ({ ...page, blocks: page.blocks.map((block) => change(block, page)) }));

const hasPanel = (page: PackPage): boolean =>
  page.blocks.some((b) => b.kind === 'narrative' && b.boardActions !== undefined);

/** One document per gate, each broken in exactly one way. */
const BROKEN: Array<{ gate: string; doc: () => PackPagesDocument; says: RegExp; diagnostic: RegExp }> = [
  {
    gate: 'a statement that does not foot',
    doc: () => {
      const p = new PackFigureProvenance();
      p.figure('packFigureSet.current.totalAssets', 3_900_000, 'money');
      p.figure('packFigureSet.current.totalLiabilities', 1_640_000, 'money');
      p.figure('packFigureSet.current.totalEquity', 2_000_000, 'money');
      return { ...clean, provenance: p, pages: [], comparativePeriod: null };
    },
    says: /The statements do not add up\..*The balance sheet does not foot.*a difference of R 260 000\.00/s,
    diagnostic: /The balance sheet does not foot/,
  },
  {
    gate: 'a balance sheet total the pack never recorded',
    doc: () => ({ ...clean, provenance: new PackFigureProvenance(), pages: [], comparativePeriod: null }),
    says: /The statements do not add up\./,
    diagnostic: /never recorded 'packFigureSet\.current\.totalAssets'/,
  },
  {
    gate: 'a figure the page states at a value the record does not hold',
    doc: () => mapBlocks((block) => (block.kind !== 'table' ? block : {
      ...block,
      table: {
        ...block.table,
        rows: block.table.rows.map((row, i) => (i !== 0 || row.figures.actual === undefined ? row : {
          ...row, figures: { ...row.figures, actual: { ...row.figures.actual, value: 1 } },
        })),
      },
    })),
    says: /A figure printed on a page is not the figure the pack recorded for it\./,
    diagnostic: /provenance map/,
  },
  {
    gate: 'prose written for a developer',
    doc: () => mapPages((page) => (page.number !== clean.pages.length ? page : {
      ...page,
      blocks: [...page.blocks, {
        kind: 'disclosure' as const,
        disclosure: { heading: 'Caveats', notes: [{ heading: 'Caveat 1', body: 'TODO: explain this.' }] },
      }],
    })),
    says: /A sentence in the pack carries wording that was not written for a reader\./,
    diagnostic: /TODO/,
  },
  {
    gate: 'the action panel and the matters page counting differently',
    doc: () => mapPages((page) => (hasPanel(page)
      ? { ...page, title: '7 of 7 matters requiring a board decision are put to the board on this page.' }
      : page)),
    says: /The board action panel and the matters page do not agree about the matters they list or count\./,
    diagnostic: /The two pages count the same matters differently/,
  },
  {
    gate: 'a column no row carries',
    doc: () => mapBlocks((block) => (block.kind !== 'table' ? block : {
      ...block, table: { ...block.table, columns: [...block.table.columns, 'budget'] },
    })),
    says: /A statement column does not hold what its heading says\./,
    diagnostic: /declares a 'budget' column that no row carries/,
  },
  {
    gate: 'a bridge that does not reach its own closing bar',
    doc: () => mapBlocks((block) => (block.kind !== 'chart' || block.chart.kind !== 'waterfall' ? block : {
      ...block,
      chart: {
        ...block.chart,
        waterfallBars: block.chart.waterfallBars?.map((bar, i) => (i === 1 ? { ...bar, end: bar.end + 5_000 } : bar)),
      },
    })),
    says: /A bridge chart does not add up/,
    diagnostic: /./,
  },
  {
    gate: 'a comparative period no statement compares against',
    doc: () => ({ ...clean, pages: clean.pages.map((page) => ({ ...page, blocks: page.blocks.filter((b) => b.kind !== 'table') })) }),
    says: /The comparative period the pack states is not the one its statements compare against\./,
    diagnostic: /claims a comparison the pack does not make/,
  },
];

describe('assertPackIntegrity refuses with a PackRefusal', () => {
  it('accepts the clean document — every case below is one change away from it', () => {
    expect(() => assertPackIntegrity(clean)).not.toThrow();
  });

  for (const { gate, doc, says, diagnostic } of BROKEN) {
    it(`${gate}: names the check, in words a reader can use`, () => {
      const refusal = refusalOf(() => assertPackIntegrity(doc()));
      expect(refusal.userMessage).toMatch(says);
      expectReadable(refusal.userMessage);
      // The engineer's half is untouched: every failure, in full.
      expect(refusal.message).toMatch(/^Pack figure integrity failed, so this render is refused/);
      expect(refusal.message).toMatch(diagnostic);
    });
  }

  it('is what composing an out-of-balance pack throws, with the gap in the reader\'s sentence', () => {
    const refusal = refusalOf(() => buildBoardPackPages(outOfBalanceInput));
    expect(refusal.userMessage).toContain('The balance sheet does not foot');
    expect(refusal.userMessage).toContain('a difference of R 450.00');
    expectReadable(refusal.userMessage);
  });

  it('names each failed check once, however many failures it produced', () => {
    const doc = mapBlocks((block) => (block.kind !== 'table' ? block : {
      ...block, table: { ...block.table, columns: [...block.table.columns, 'budget'] },
    }));
    const refusal = refusalOf(() => assertPackIntegrity(doc));
    expect(refusal.message.match(/no row carries/g)!.length).toBeGreaterThan(1);
    expect(refusal.userMessage.match(/A statement column does not hold/g)).toHaveLength(1);
  });
});
