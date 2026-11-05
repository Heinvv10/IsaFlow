/**
 * PAGE 9 NUMBERS ITS FOOTNOTES 1..n, WHICHEVER OF THEM THE COMPANY EARNS.
 *
 * The row-marker note is always number 1 and the prior-column note was always number 2, so a
 * scorecard with only the prior-column note (no trend panels, no disowned base) printed a lone "2"
 * in the footnote list and "2" on every PRIOR heading, with no 1 anywhere. The prior-column note is
 * numbered after however many row notes the page carries.
 *
 * Swept over every board-pack fixture times {original trend, no trend, zero-revenue trend} times
 * {with prior, without}: on the Scorecard page the footnote numbers run 1..n, every superscript
 * resolves to a footnote, and every footnote is anchored.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import {
  brightsphereInput, brightspherePriorInput, brightsphereLiveInput, brightsphereReceivablesGapInput, demoInput, denseInput,
  noRatioPanelsInput, outOfBalanceInput, zeroRevenueTrend,
} from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const BASES: Array<[string, BoardPackInput]> = [
  ['demo', demoInput], ['dense', denseInput], ['noRatioPanels', noRatioPanelsInput], ['outOfBalance', outOfBalanceInput],
  ['brightsphere', brightsphereInput], ['brightspherePrior', brightspherePriorInput], ['brightsphereLive', brightsphereLiveInput],
  ['brightsphereReceivablesGap', brightsphereReceivablesGapInput], ['liveDemo', liveDemoInput], ['liveDemoShortPanels', liveDemoShortPanelsInput],
];

function variants(): Array<[string, BoardPackInput]> {
  const out: Array<[string, BoardPackInput]> = [];
  for (const [name, base] of BASES) {
    for (const [trendName, trend] of [['trend', base.trend], ['no trend', []], ['zero trend', zeroRevenueTrend]] as const) {
      for (const withPrior of [true, false]) {
        out.push([`${name}, ${trendName}, ${withPrior ? 'prior' : 'no prior'}`,
          { ...base, trend: [...trend], set: { ...base.set, prior: withPrior ? base.set.prior : null } }]);
      }
    }
  }
  return out;
}

/** Every number the scorecard page prints a superscript for. */
function anchored(page: PackPage): number[] {
  const out: number[] = [];
  for (const block of page.blocks) {
    if (block.kind !== 'scorecard') continue;
    for (const g of block.groups) for (const r of g.rows) if (r.footnote !== undefined) out.push(r.footnote);
    if (block.priorFootnote !== null && block.priorFootnote !== undefined) out.push(block.priorFootnote);
  }
  return out;
}

describe('the Scorecard page footnotes', () => {
  it('run 1..n, every superscript resolves and every footnote is anchored, across every fixture and variant', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const faults: string[] = [];
    let withPriorOnly = 0;
    let built = 0;
    let refused = 0;
    try {
      for (const [name, input] of variants()) {
        let page: PackPage | undefined;
        try {
          page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Scorecard');
        } catch (err) {
          // A fixture this variant makes inconsistent (a trend that no longer ties to its closing cash) is
          // refused by the figure gate before any page exists; it has no scorecard to check.
          if (!(err instanceof PackRefusal)) throw err;
          refused += 1;
          continue;
        }
        if (page === undefined) throw new Error(`${name}: no Scorecard page`);
        built += 1;
        const numbers = page.footnotes.map((f) => f.number);
        const marks = new Set(anchored(page));
        if (numbers.some((n, i) => n !== i + 1)) faults.push(`${name}: footnotes ${numbers.join(',')}`);
        for (const m of marks) if (!numbers.includes(m)) faults.push(`${name}: superscript ${m} resolves to nothing`);
        for (const n of numbers) if (!marks.has(n) && !page.footnotes.find((f) => f.number === n)!.text.startsWith('Not printed')) faults.push(`${name}: footnote ${n} is anchored by nothing`);
        if (numbers.length === 1 && marks.size > 0) withPriorOnly += 1;
      }
    } finally {
      warn.mockRestore();
    }
    // The sweep reaches the shape that was wrong: a scorecard whose only note is the prior-column one.
    expect(withPriorOnly, 'no variant is a scorecard with a single note').toBeGreaterThan(0);
    expect(built, `${refused} variants refused by the figure gate`).toBeGreaterThanOrEqual(40);
    expect(faults).toEqual([]);
  }, 300_000);
});
