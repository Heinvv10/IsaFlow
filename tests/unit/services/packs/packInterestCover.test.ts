/**
 * PAGE 9 STATES INTEREST COVER, AND IT IS THE ENGINE'S.
 *
 * The scorecard's Interest cover row said "Interest expense is not captured
 * in the pack figure set" of a figure set that had started carrying the
 * ledger's interest expense — read for every window, and not handed to the
 * engine. Financial Analysis and the management pack printed the ratio for
 * the same company and period; the board pack said it had no way to.
 *
 * One ratio under one name: operating profit over interest EXPENSE, gross of
 * any interest earned — `calculateExtendedRatios.interestCoverage`. Where it
 * is not stated the reason is the engine's own, and there are three, each a
 * different fact: the ledger records none; the figures could not be read; the
 * report never read them.
 */
import { describe, expect, it } from 'vitest';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { RATIO_INPUTS_NOT_READ } from '@/modules/accounting/services/reports/reportPackDataService';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { buildScorecardGroups, packFiguresToFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { TERMS as GLOSSARY_TERMS } from '@/modules/accounting/services/packs/pages/packGlossaryTerms';
import {
  brightsphereLiveInput, demoInput, demoSet, denseInput, figures, NO_LEDGER_RATIO_INPUTS, ratioInputsUnreadInput,
} from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';

const row = (set: typeof demoSet) => buildScorecardGroups(set, new PackFigureProvenance())
  .flatMap((g) => g.rows).find((r) => r.metric === 'Interest cover')!;
const NONE_RECORDED = 'No interest expense recorded in the period, so this ratio cannot be stated.';

/** Everything a composed pack prints, as one string per page. */
const printed = (input: BoardPackInput): string[] => buildBoardPackPages(input).pages.map((page) => JSON.stringify(page));
const scorecardPage = (input: BoardPackInput): string => printed(input).find((p) => p.includes('"Interest cover"') && p.includes('"scorecard"'))!;

describe('the scorecard\'s interest cover', () => {
  it('is the figure the engine gives Financial Analysis for the same input', () => {
    // The demo company: operating profit 750 000 over interest expense of
    // 48 000 — gross, not the 42 000 net of the 6 000 it earned.
    const engine = calculateExtendedRatios({
      revenue: 4_200_000, costOfSales: 2_310_000, operatingExpenses: 1_180_000, operatingProfit: 750_000, otherIncome: 40_000,
      netProfit: 512_000, totalAssets: 3_900_000, totalLiabilities: 1_640_000, totalEquity: 2_260_000, currentAssets: 1_850_000,
      currentLiabilities: 940_000, inventory: 310_000, accountsReceivable: 720_000, accountsPayable: 430_000, cash: 610_000,
      interestExpense: 48_000, interestIncome: 6_000,
    });
    const cover = row(demoSet);
    expect(engine.interestCoverage).toBe(15.63);
    expect(cover.actual.value).toBe(engine.interestCoverage);
    expect(cover.actual.basis).toEqual({ numerator: 750_000, denominator: 48_000 });
    // No target is set for it: stated, and unscored.
    expect(cover.target).toBeNull();
    expect(cover.status).toBe('unscored');
  });

  it('states the comparative period\'s cover from that period\'s own interest', () => {
    expect(row(demoSet).prior?.value).toBe(calculateExtendedRatios(packFiguresToFinancialData(demoSet.prior!)).interestCoverage);
    expect(row(demoSet).prior?.value).toBe(10.77);
  });

  it('says the ledger records none, in the engine\'s words, where it was read and holds none', () => {
    const current = figures({ ...NO_LEDGER_RATIO_INPUTS });
    const cover = row({ ...demoSet, current });
    expect(cover.actual.value).toBeNull();
    expect(cover.status).toBe('notMeaningful');
    expect(cover.actual.unavailable).toBe(NONE_RECORDED);
    expect(cover.actual.unavailable).toBe(calculateExtendedRatios(packFiguresToFinancialData(current)).notMeaningful.interestCoverage);
    // The comparative is stated; only the current period's reason prints.
    expect(cover.prior?.value).toBe(10.77);
  });

  it('says the comparative period records none, and that it is the comparative', () => {
    const cover = row({ ...demoSet, prior: figures({ ...NO_LEDGER_RATIO_INPUTS }) });
    expect(cover.actual.value).toBe(15.63);
    expect(cover.prior?.unavailable).toBe(`In the comparative period: n${NONE_RECORDED.slice(1)}`);
  });

  it('says the figures could not be read where the read failed — not that there are none', () => {
    const cover = row(ratioInputsUnreadInput.set);
    expect(cover.actual.value).toBeNull();
    expect(cover.actual.unavailable).toBe(RATIO_INPUTS_NOT_READ);
    // True of both periods, so it is one sentence, not two.
    expect(cover.prior?.unavailable).toBe(RATIO_INPUTS_NOT_READ);
  });
});

describe('page 9, composed', () => {
  it('prints the cover on the demo company, and no footnote about interest', () => {
    const page = scorecardPage(demoInput);
    expect(page).toContain('"value":15.63');
    expect(page).not.toMatch(/interest expense/i);
    expect(page).not.toContain('not captured');
  });

  it.each([
    ['none recorded — Brightsphere as the live route composed it', brightsphereLiveInput, NONE_RECORDED],
    ['none recorded — the live demo company, on negative equity', liveDemoInput, NONE_RECORDED],
    ['the read failed', ratioInputsUnreadInput, RATIO_INPUTS_NOT_READ],
  ])('prints the engine\'s reason and still fits its sheet: %s', (_name, input, reason) => {
    // `buildBoardPackPages` refuses a pack whose page does not fit its box or
    // fails an integrity gate, so composing at all is the fit and the gates.
    expect(scorecardPage(input)).toContain(reason);
  });

  it('never says the pack does not capture interest, on any fixture', () => {
    for (const input of [demoInput, denseInput, brightsphereLiveInput, liveDemoInput, ratioInputsUnreadInput]) {
      expect(printed(input).join('\n')).not.toMatch(/not captured in (the pack figure set|this report)|captures no interest/i);
    }
  });

  it('defines the ratio it prints: gross interest expense, not net', () => {
    const term = GLOSSARY_TERMS.find((t) => t.term === 'Interest cover')!;
    expect(term.definition).toMatch(/divided by interest expense/);
    expect(term.definition).toMatch(/gross/);
    expect(term.definition).not.toMatch(/net interest|captures no/);
  });

  it('changes nothing else the pack prints: only page 9 differs when the ledger inputs arrive', () => {
    const without = (f: typeof demoSet.current) => ({ ...f, interestExpense: undefined, interestIncome: undefined, taxExpense: undefined,
      employeeCosts: undefined, employeeCount: undefined, directMaterialCosts: undefined });
    const bare: BoardPackInput = { ...demoInput, set: { ...demoSet, current: without(demoSet.current), prior: without(demoSet.prior!) } };
    const [a, b] = [printed(bare), printed(demoInput)];
    expect(a.length).toBe(b.length);
    const differing = a.flatMap((page, i) => (page === b[i] ? [] : [i + 1]));
    expect(differing).toEqual([9]);
  });
});
