/**
 * The board pack across the JSON boundary.
 *
 * WHAT THIS FILE IS FOR: `TrustedChartSvg` is a compile-time brand and it does
 * not survive `JSON.parse`. Every SVG-bearing field must therefore be re-run
 * through the guards on the far side, and "must" is only true if something
 * fails when one of them is not. So each of the four fields is tampered with
 * INDEPENDENTLY below — a walk that adopted the chart but passed the
 * sparklines straight through would still satisfy a single happy-path
 * round-trip test.
 *
 * WHAT THE FIXTURE CANNOT REACH. `demoInput` builds real charts, small
 * multiples and sparklines, but `buildScorecardGroups` emits `trendSvg: null`
 * and `bulletSvg: null` for every row today — nothing populates them yet,
 * though `ScorecardTable` already inlines both via `dangerouslySetInnerHTML`.
 * A test driven only by the fixture would leave those two fields unadopted
 * and score green. They are injected explicitly, with REAL `renderChartSvg`
 * output, so the branch is reached rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  adoptPackPagesDocument,
  serialisePackPagesDocument,
  type SerialisedPackPagesDocument,
} from '@/modules/accounting/services/packs/pages/packDocumentWire';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { demoInput } from './fixtures/boardPackInputs';

const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>';
const REAL_SVG = renderChartSvg(
  { xAxis: { type: 'category', data: ['a'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1] }] },
  { widthMm: 30, heightMm: CHART_HEIGHT_MM.inline },
);

const built = buildBoardPackPages(demoInput);

/** A REAL round trip — `JSON.parse(JSON.stringify(...))`, not a structured
 *  clone and not the object itself. `undefined` is dropped, class instances
 *  flatten, and the brand is erased: that is the boundary under test. */
function wire(): SerialisedPackPagesDocument {
  return JSON.parse(JSON.stringify(serialisePackPagesDocument(built))) as SerialisedPackPagesDocument;
}

type Loose = { kind: string; [key: string]: unknown };

/** Every block of a kind, as a loose object so a test can tamper with a field
 *  the wire type declares as `string`. */
function blocks(payload: SerialisedPackPagesDocument, kind: string): Loose[] {
  return payload.pages.flatMap((page) => page.blocks as unknown as Loose[]).filter((b) => b.kind === kind);
}

function firstBlock(payload: SerialisedPackPagesDocument, kind: string): Loose {
  const found = blocks(payload, kind)[0];
  // A fixture that stopped producing this block kind would otherwise make the
  // tamper tests below pass by tampering with nothing.
  if (found === undefined) throw new Error(`fixture carries no '${kind}' block`);
  return found;
}

/** The scorecard rows, with both SVG fields populated — see the file header
 *  for why the fixture cannot do this itself. */
function withScorecardSvgs(payload: SerialisedPackPagesDocument): Loose[] {
  const groups = firstBlock(payload, 'scorecard').groups as Array<{ rows: Loose[] }>;
  const rows = groups.flatMap((g) => g.rows);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    row.trendSvg = REAL_SVG;
    row.bulletSvg = REAL_SVG;
  }
  return rows;
}

describe('serialise -> adopt round trip', () => {
  it('returns every chart, panel and sparkline byte-for-byte', () => {
    const adopted = adoptPackPagesDocument(wire());

    const chartsOf = (doc: typeof built) =>
      doc.pages.flatMap((page) =>
        page.blocks.flatMap((block) => {
          if (block.kind === 'chart') return [block.chart.svg];
          if (block.kind === 'smallMultiples') return block.panels.map((p) => p.svg);
          if (block.kind === 'kpiTiles') return block.tiles.map((t) => t.sparklineSvg ?? 'null');
          return [];
        }),
      );

    expect(chartsOf(adopted)).toEqual(chartsOf(built));
    // The fixture must actually carry charts, or the equality above is a
    // comparison of two empty arrays.
    expect(chartsOf(built).filter((s) => s !== 'null').length).toBeGreaterThan(5);
  });

  it('carries the document metadata a printed pack reads', () => {
    const adopted = adoptPackPagesDocument(wire());

    expect(adopted.packType).toBe('board');
    expect(adopted.pages).toHaveLength(12);
    expect(adopted.draft).toBe(built.draft);
    expect(adopted.brand).toEqual(built.brand);
    expect(adopted.numberConvention).toEqual(built.numberConvention);
    expect(adopted.basisOfPreparation).toEqual(built.basisOfPreparation);
  });

  it('keeps a null sparkline null rather than refusing it', () => {
    const payload = wire();
    const tiles = firstBlock(payload, 'kpiTiles').tiles as Loose[];
    tiles[0]!.sparklineSvg = null;

    const adopted = adoptPackPagesDocument(payload);
    const block = adopted.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'kpiTiles');

    expect(block?.kind === 'kpiTiles' && block.tiles[0]!.sparklineSvg).toBeNull();
  });
});

describe('every SVG-bearing field goes through the guards', () => {
  it('refuses a tampered chart svg', () => {
    const payload = wire();
    firstBlock(payload, 'chart').chart = { ...(firstBlock(payload, 'chart').chart as object), svg: HOSTILE };

    expect(() => adoptPackPagesDocument(payload)).toThrow(/external reference/i);
  });

  it('refuses a tampered small-multiples panel', () => {
    const payload = wire();
    const panels = firstBlock(payload, 'smallMultiples').panels as Loose[];
    panels[panels.length - 1]!.svg = HOSTILE;

    expect(() => adoptPackPagesDocument(payload)).toThrow(/external reference/i);
  });

  it('refuses a tampered KPI sparkline', () => {
    const payload = wire();
    const tiles = firstBlock(payload, 'kpiTiles').tiles as Loose[];
    const target = tiles.find((t) => typeof t.sparklineSvg === 'string');
    if (target === undefined) throw new Error('fixture carries no sparkline to tamper with');
    target.sparklineSvg = HOSTILE;

    expect(() => adoptPackPagesDocument(payload)).toThrow(/external reference/i);
  });

  it('refuses a tampered scorecard trend svg', () => {
    const payload = wire();
    withScorecardSvgs(payload)[0]!.trendSvg = HOSTILE;

    expect(() => adoptPackPagesDocument(payload)).toThrow(/external reference/i);
  });

  it('refuses a tampered scorecard bullet svg', () => {
    const payload = wire();
    withScorecardSvgs(payload)[0]!.bulletSvg = HOSTILE;

    expect(() => adoptPackPagesDocument(payload)).toThrow(/external reference/i);
  });

  it('adopts populated scorecard svgs when they are legitimate', () => {
    const payload = wire();
    withScorecardSvgs(payload);

    const adopted = adoptPackPagesDocument(payload);
    const block = adopted.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'scorecard');
    const row = block?.kind === 'scorecard' ? block.groups[0]!.rows[0]! : null;

    expect(row?.trendSvg).toBe(REAL_SVG);
    expect(row?.bulletSvg).toBe(REAL_SVG);
  });

  it('refuses a chart field that is missing from the payload entirely', () => {
    const payload = wire();
    const tiles = firstBlock(payload, 'kpiTiles').tiles as Loose[];
    delete tiles[0]!.sparklineSvg;

    expect(() => adoptPackPagesDocument(payload)).toThrow(/adoptTrustedChartSvg/);
  });
});

describe('the deserialisation boundary validates structure, not just markup', () => {
  it('refuses a block kind no renderer knows', () => {
    const payload = wire();
    (payload.pages[2]!.blocks as unknown as Loose[]).push({ kind: 'iframe', src: 'https://evil.example' });

    expect(() => adoptPackPagesDocument(payload)).toThrow(/unknown block kind/);
  });

  it('replays the provenance rather than shipping an empty one', () => {
    const adopted = adoptPackPagesDocument(wire());

    const flatten = (doc: typeof built) => [...doc.provenance.all().values()].flat();
    expect(flatten(adopted)).toEqual(flatten(built));
    expect(flatten(built).length).toBeGreaterThan(50);
    expect(() => adopted.provenance.assertConsistent()).not.toThrow();
  });

  it("refuses a figure the composer could not have issued", () => {
    const payload = wire();
    // Null value, no reason — `PackFigureProvenance.figure` refuses this, and
    // replaying through it is what makes the refusal reach the wire.
    payload.provenance.push({ value: null, format: 'money', source: 'forged.field' });

    expect(() => adoptPackPagesDocument(payload)).toThrow(/no value and no reason/);
  });
});
