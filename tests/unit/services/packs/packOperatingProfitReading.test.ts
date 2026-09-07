/**
 * ONE reading of the operating line, enforced rather than offered.
 *
 * The first fix for this made `packMetricReads.operatingProfitOf` available
 * and routed two call sites through it. A helper the next author can bypass
 * is not a fix, and two call sites in that very diff already did:
 * `highlightsTitle` read `operatingProfit ?? 0` and `resultsTitle` read
 * `operatingProfit ?? netProfit`. On a company whose classifier produced no
 * operating line that printed "Operating margin is 0.0%" beside a tile
 * showing 750 000, and "operating profit of 512 000" above a table row
 * showing 750 000.
 *
 * That is strictly worse than the crash it replaced. A hard render failure is
 * loud and diagnosable; a pack whose title contradicts the figure three
 * centimetres away SHIPS, and tells a director something false.
 *
 * Two assertions, because neither alone is enough. The first is behavioural —
 * it composes the real document and reads the title against the cell beside
 * it, which is the assertion shape nothing in this suite had. The second is a
 * scoped guard over the pack services only, allow-listing the one module that
 * is allowed to read the raw field; a text guard is a linter, not a proof,
 * and it is here to stop the NEXT bypass rather than to demonstrate this one.
 *
 * THE DOCSTRING ABOVE DESCRIBED A TEST THAT WAS NOT HERE. There was no
 * behavioural assertion at all: nothing composed a document, nothing compared
 * a title with a cell, and the file was one unit test of `operatingProfitOf`
 * plus a text guard that was wrong in BOTH directions — a bare comment
 * mentioning `f.operatingProfit` turned it red, and a real bypass written by
 * destructuring (`const { operatingProfit } = f`) left it green. The
 * behavioural test is written now, and the guard reads source with its
 * comments stripped and knows what a destructure looks like.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

const PACK_SERVICES = 'src/modules/accounting/services/packs';

/**
 * Source with its comments taken out.
 *
 * Deliberately simple — it does not know that a `//` inside a string literal
 * is not a comment. What it has to be right about is prose ABOUT the field,
 * which is what turned the guard red on a no-op, and the pack services carry
 * no string literal containing `operatingProfit`.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The ways a module can read the raw optional field off a figure set.
 *
 * A property read is the obvious one and was the only one guarded. The second
 * is the bypass an author actually writes when a helper is in the way, and it
 * is invisible to the first: `const { operatingProfit } = f`.
 */
const RAW_READS: RegExp[] = [
  /\.operatingProfit\b/,
  /\{[^{}]*\boperatingProfit\b[^{}]*\}\s*=[^=]/,
  /\(\s*\{[^{}]*\boperatingProfit\b[^{}]*\}/,
];

/** The one module permitted to read `ReportPackFigures.operatingProfit`. */
const ALLOWED = new Set(['packMetricReads.ts']);

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A pack whose classifier produced NO operating line — the case the whole
 * rule exists for.
 *
 * Every fixture in the suite carries `operatingProfit`, and while it is
 * present a bypass and the helper agree, so a document built on one of them
 * cannot tell them apart. This deletes the field from both periods, which is
 * exactly what `ReportPackInput.operatingProfit` being optional means, and
 * makes `?? 0` and `operatingProfitOf` disagree by the whole figure.
 */
function withNoClassifierLine(): BoardPackInput {
  const strip = (f: ReportPackFigures): ReportPackFigures => {
    const { operatingProfit: unused, ...rest } = f;
    return rest as ReportPackFigures;
  };
  return {
    ...demoInput,
    set: {
      ...demoInput.set,
      current: strip(demoInput.set.current),
      prior: demoInput.set.prior ? strip(demoInput.set.prior) : demoInput.set.prior,
    },
  };
}

/** The percentage a sentence states as the operating margin, or null. */
function statedMargin(title: string): number | null {
  const found = /Operating margin is a (positive|negative) ([\d.]+)%/.exec(title);
  if (found === null) return null;
  return (found[1] === 'negative' ? -1 : 1) * Number(found[2]);
}

describe('page 3 reads its own tile', () => {
  it('states the margin the tile beside it carries, on a pack with no classifier line', () => {
    const doc = buildBoardPackPages(withNoClassifierLine());
    const page = doc.pages.find((p) => p.navLabel === 'Highlights')!;
    const tiles = page.blocks.find((b) => b.kind === 'kpiTiles');
    const tileOf = (label: string): number | null => (tiles?.kind === 'kpiTiles'
      ? tiles.tiles.find((t) => t.label === label)?.figure.value ?? null
      : null);

    const operating = tileOf('Operating profit');
    const revenue = tileOf('Revenue');
    // NOT VACUOUS: the fixture must actually reach the fallback, and the
    // fallback must not be the zero a bypass would print.
    expect(operating, 'the tile carries no operating profit — this fixture proves nothing')
      .not.toBeNull();
    expect(operating).not.toBe(0);
    expect(operating).toBe(operatingProfitOf(withNoClassifierLine().set.current));

    const stated = statedMargin(page.title);
    expect(stated, `page 3's title states no operating margin: ${page.title}`).not.toBeNull();
    // The title and the tile are one reading, to the decimal the title prints.
    expect(stated!).toBeCloseTo((operating! / revenue!) * 100, 1);
  });

  it('reads the same line on the income statement as on the tile', () => {
    const doc = buildBoardPackPages(withNoClassifierLine());
    const tiles = doc.pages.find((p) => p.navLabel === 'Highlights')!
      .blocks.find((b) => b.kind === 'kpiTiles');
    const tile = tiles?.kind === 'kpiTiles'
      ? tiles.tiles.find((t) => t.label === 'Operating profit')?.figure.value ?? null
      : null;
    const table = doc.pages.find((p) => p.navLabel === 'Income statement')!
      .blocks.find((b) => b.kind === 'table');
    const row = table?.kind === 'table'
      ? table.table.rows.find((r) => r.label === 'Operating profit')?.figures.actual?.value ?? null
      : null;
    expect(row).not.toBeNull();
    expect(row).toBe(tile);
  });
});

describe('the operating line has one reading', () => {
  it('resolves the classifier line when present and its documented fallback when not', () => {
    const base = { revenue: 100, costOfSales: 40, otherIncome: 5, operatingExpenses: 30 } as ReportPackFigures;
    expect(operatingProfitOf({ ...base, operatingProfit: 12 })).toBe(12);
    expect(operatingProfitOf({ ...base, operatingProfit: undefined })).toBe(35);
  });

  it('is the only place in the pack services that reads the raw optional field', () => {
    const offenders = tsFilesUnder(PACK_SERVICES)
      .filter((path) => !ALLOWED.has(path.split('/').pop()!))
      .filter((path) => {
        const source = code(readFileSync(path, 'utf8'));
        return RAW_READS.some((pattern) => pattern.test(source));
      });
    expect(offenders).toEqual([]);
  });
});
