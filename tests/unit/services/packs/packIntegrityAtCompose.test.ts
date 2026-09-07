/**
 * The gate as the COMPOSER runs it — `packFigureIntegrity.test.ts` split for
 * the file-size cap, along the seam that was already there.
 *
 * That file drives `assertPackIntegrity` directly against hand-built
 * documents, which is how each rejection branch is reached. This one asserts
 * the things that are only true of a pack the real composer built: that the
 * gate is CALLED (a gate nothing invokes passes every test in the other
 * file), and that the four fixes this round made are visible in the document
 * a director would actually be handed.
 */
import { describe, expect, it } from 'vitest';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import {
  disproportionatePlugSentence,
  uncapturedShare,
} from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereInput, demoInput, demoSet, figures } from './fixtures/boardPackInputs';

const template = buildBoardPackPages(demoInput);

describe('buildBoardPackPages calls the gate', () => {
  it('refuses to build a pack whose balance sheet does not foot', () => {
    // A gate nothing invokes is the failure mode that matters most: every
    // test above would still pass with the call site deleted.
    const broken = { ...demoInput, set: { ...demoSet, current: figures({ totalEquity: 2_000_000 }) } };
    expect(() => buildBoardPackPages(broken)).toThrow(/integrity/i);
  });

  it('heads the comparative column with the window the prior figures were read over', () => {
    // The label the composer prints and the window it read must agree, and
    // both must reach the reader: page 12's basis, and a footnote under every
    // statement that carries a prior column.
    expect(template.comparativePeriod).toEqual({
      label: '1 September 2025 to 28 February 2026',
      start: demoSet.priorWindow.start,
      end: demoSet.priorWindow.end,
    });
    for (const number of [5, 6, 7, 8]) {
      const notes = template.pages.find((pg) => pg.number === number)!.footnotes;
      expect(notes.some((f) => f.text.includes('1 September 2025 to 28 February 2026')), `page ${number}`).toBe(true);
    }
    const basisNotes = template.pages.find((pg) => pg.number === 12)!.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    expect(basisNotes.some((n) => n.heading === 'Comparative period' && n.body.includes('1 September 2025'))).toBe(true);
  });

  it('states no comparative period, and shows no comparative column, without a prior period', () => {
    // Brightsphere. The absent half of R-P55, and the one a symmetric check
    // would otherwise fail on an honest pack.
    const doc = buildBoardPackPages(brightsphereInput);
    expect(doc.comparativePeriod).toBeNull();
    const columns = doc.pages.flatMap((pg) => pg.blocks)
      .flatMap((b) => (b.kind === 'table' ? [...b.table.columns] : []));
    expect(columns).not.toContain('prior');
    const basisNotes = doc.pages.find((pg) => pg.number === 12)!.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    expect(basisNotes.some((n) => n.heading === 'Comparative period' && /None\./.test(n.body))).toBe(true);
  });

  it('does not hold the operating line to a formula the classifier does not use (I-2)', () => {
    // Why operating profit is NOT an identity while gross profit is. Gross
    // profit is derived by the pack — revenue less cost of sales, both
    // recorded — so it is checkable. The operating line is READ from the
    // classifier, and the classifier's answer is not the naive formula: on
    // the demo figures it is 735,000 where revenue − cost of sales + other
    // income − operating expenses gives 750,000, the 15,000 difference being
    // other expenses, which the classifier puts above the line and the
    // formula omits. An identity asserting the formula would fail this
    // honest pack. What DOES hold the line together is that every page reads
    // it through one source, which `assertConsistent` already enforces.
    const f = demoSet.current;
    const naive = f.revenue - f.costOfSales + (f.otherIncome ?? 0) - f.operatingExpenses;
    expect(operatingProfitOf(f)).toBe(735_000);
    expect(naive).toBe(750_000);
    expect(naive - operatingProfitOf(f)).toBe(f.otherExpenses);
    // And the pack renders, which it would not if the formula were asserted.
    expect(() => buildBoardPackPages(demoInput)).not.toThrow();
  });

  it('reports the current-liability ratios as not meaningful when there are none (I-1)', () => {
    // `safeDiv` returns 0 on a zero denominator, and 0.00 cover reads as the
    // opposite of the truth for a company that owes nothing short-term. The
    // branch is unreachable from both standing fixtures, so it is driven here.
    const set = { ...demoSet, current: figures({ currentLiabilities: 0 }), prior: null };
    const doc = buildBoardPackPages({ ...demoInput, set });
    const rows = doc.pages.find((pg) => pg.number === 9)!.blocks
      .flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []));
    for (const metric of ['Current ratio', 'Cash ratio']) {
      const row = rows.find((r) => r.metric === metric)!;
      expect(row.actual.value, metric).toBeNull();
      expect(row.actual.unavailable, metric).toMatch(/no current liabilities/i);
    }
  });

  it('tells the reader how big each bridge\'s unmeasured step is (I-3)', () => {
    // Both production bridges breach the threshold on the demo figures —
    // page 6 at 44% of net profit, page 8 at 214% of the net cash movement —
    // so both pages must carry the sentence. If a threshold change silences
    // one of them, this goes red rather than the pack going quiet.
    for (const number of [6, 8]) {
      const pg = template.pages.find((x) => x.number === number)!;
      const chart = pg.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))
        .find((c) => c.kind === 'waterfall')!;
      const share = uncapturedShare(chart.waterfallBars!);
      expect(share, `page ${number} share`).toBeGreaterThan(0.1);
      const said = disproportionatePlugSentence(chart, PACK_SCALE)!;
      const prose = pg.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []));
      expect(prose.some((t) => t.includes(said)), `page ${number} prose`).toBe(true);
    }
  });

  it('resolves every matter\'s quantum through the provenance map (I-4)', () => {
    const recorded = template.provenance.all();
    const matters = template.pages.find((pg) => pg.number === 11)!.blocks
      .flatMap((b) => (b.kind === 'matters' ? b.matters : []));
    expect(matters.length).toBeGreaterThan(0);
    for (const matter of matters) {
      expect(recorded.has(matter.quantum.source), matter.quantum.source).toBe(true);
      expect(matter.quantum.value).toBe(244_800);
    }

    // And a matter with no single amount states why, rather than printing a
    // zero that would say the exposure was measured and found to be nothing.
    const none = buildBoardPackPages(brightsphereInput).pages.find((pg) => pg.number === 11)!
      .blocks.flatMap((b) => (b.kind === 'matters' ? b.matters : []));
    expect(none[0]!.quantum.value).toBeNull();
    expect(none[0]!.quantum.unavailable).toMatch(/no single rand amount/i);

    // TWO matters, because both standing fixtures carry exactly one — and a
    // single matter can never collide with itself, so a shared source would
    // pass every assertion above. Two matters at different quanta against one
    // source is a self-contradicting pack that `assertConsistent` refuses.
    const many = buildBoardPackPages({
      ...demoInput,
      matters: [
        { ...demoInput.matters[0]!, quantum: 244_800 },
        { ...demoInput.matters[0]!, issue: 'Unreconciled bank items', quantum: 91_400 },
      ],
    }).pages.find((pg) => pg.number === 11)!.blocks.flatMap((b) => (b.kind === 'matters' ? b.matters : []));
    expect(many).toHaveLength(2);
    expect(many[0]!.quantum.source).not.toBe(many[1]!.quantum.source);
    expect(many.map((m) => m.quantum.value)).toEqual([244_800, 91_400]);
  });

  it('bridges revenue to net profit through a named uncaptured step', () => {
    // Before the gate, page 6's Net Profit bar floated R223,000 clear of the
    // chain under a title claiming revenue "bridges to" net profit. The gate
    // refuses that, so the gap is drawn as its own bar.
    const bars = template.pages.find((pg) => pg.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!.waterfallBars!;
    expect(bars.map((b) => b.label)).toContain('Other, not separately captured');
    expect(bars[bars.length - 2]!.end).toBe(demoSet.current.netProfit);
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.netProfit);
    expect(bars.some((b) => b.kind === 'subtotal')).toBe(true);
  });
});
