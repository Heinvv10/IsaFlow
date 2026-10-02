/**
 * A RED MISS SCORED ON A FIGURE THE PACK DISOWNS TWO SHEETS EARLIER.
 *
 * The demo pack's sheet 9 prints `Current ratio · (0.14) · target 1.50 ·
 * MISSED` in red; its sheet 7 says of the numerator "Current assets are
 * (464). An asset below zero is not a balance a business can hold … the
 * balances should be resolved before this sheet is relied on."
 * Brightsphere's ONLY scored target is the same ratio, on current assets of
 * (3 372), under the same words. The pack scored a judgement against figures
 * it had already qualified, and the cross-reference ran one way.
 *
 * The flag is DERIVED from `METRIC_INPUTS` — which ledger figures each ratio
 * is taken on — rather than written per row, so it cannot be true of one
 * ratio and not the next. These hold that: every scored row whose inputs are
 * qualified carries the marker, and no row whose inputs are sound does.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument, PackScorecardRow } from '@/modules/accounting/services/packs/pages/packPageModel';
import {
  disownedBases, disownedBasesFootnoteText, METRIC_INPUTS, NO_DECLARED_INPUTS,
} from '@/modules/accounting/services/packs/pages/packDisownedBases';
import { SCORECARD_METRICS } from '@/modules/accounting/services/packs/pages/packScorecard';
import type { PackScorecardGroup } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

/** The figures a scored row stands on THAT PAGE 7 STATES, as this pack names
 *  them there. Kept here independently of the production table so the test is
 *  not the code.
 *
 *  Cash and inventory are absent on purpose, and that is the finding this
 *  round closed: page 7's block is built from the asset and liability ROWS of
 *  the position table plus the two memorandum lines, and neither cash nor
 *  inventory is any of them — inventory is not printed in the pack at all. A
 *  flag derived from them pointed a director at a statement the balance sheet
 *  never made. */
const STANDS_ON: Record<string, readonly string[]> = {
  'current ratio': ['current assets', 'current liabilities'],
  'cash ratio': ['current liabilities'],
  'debtor days': ['trade receivables'],
  'creditor days': ['trade payables'],
  'debt-to-equity': ['total liabilities'],
  'cash conversion cycle': ['trade receivables', 'trade payables'],
};

/** What page 7's "Balances below zero" block actually named, read off the
 *  composed sheet. The whole point of the flag is that page 9 points at THIS
 *  statement, so the expectation is derived from it rather than re-derived
 *  from the figure set. */
function page7Disowns(doc: PackPagesDocument): Set<string> {
  const page = doc.pages.find((p) => p.navLabel === 'Balance sheet');
  const said = (page?.blocks ?? [])
    .filter((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Balances below zero')
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
    .join(' ')
    .toLowerCase();
  return new Set(
    ['current assets', 'current liabilities', 'total liabilities', 'trade receivables', 'trade payables']
      .filter((label) => said.includes(label)),
  );
}

function scorecardRows(doc: PackPagesDocument): PackScorecardRow[] {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind === 'scorecard') return block.groups.flatMap((g) => g.rows);
    }
  }
  throw new Error('no scorecard in this pack');
}

function scorecardFootnotes(doc: PackPagesDocument): Map<number, string> {
  const page = doc.pages.find((p) => p.navLabel === 'Scorecard')!;
  return new Map(page.footnotes.map((f) => [f.number, f.text]));
}

describe('a scored row says when its base is one the pack qualifies', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`marks every scored row standing on a disowned figure on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const rows = scorecardRows(doc);
      const notes = scorecardFootnotes(doc);
      const disownedFields = page7Disowns(doc);

      const scored = rows.filter((r) => r.status === 'met' || r.status === 'missed');
      expect(scored.length, 'nothing is scored, so nothing is being checked').toBeGreaterThan(0);

      for (const row of scored) {
        const inputs = STANDS_ON[row.metric.toLowerCase()];
        if (inputs === undefined) continue;
        const disowned = inputs.some((field) => disownedFields.has(field));
        if (!disowned) continue;
        expect(
          row.footnote,
          `${company}: ${row.metric} is scored on a figure below zero and carries no marker`,
        ).toBeDefined();
        const text = notes.get(row.footnote!) ?? '';
        expect(text, `${company}: ${row.metric}'s marker points at a note that says nothing about its base`)
          .toMatch(/^Scored on /);
      }
    });

    it(`flags exactly the rows whose figures the pack qualifies on ${company}`, () => {
      // SET EQUALITY, in both directions. Asserting only that flagged rows
      // are qualified passes a guard that flags every scored row, which would
      // tell a director a healthy ratio is suspect — the mirror defect, and
      // one a one-directional check cannot see.
      const doc = buildBoardPackPages(input);
      const notes = scorecardFootnotes(doc);
      const rows = scorecardRows(doc);
      const disownedFields = page7Disowns(doc);

      const expected = rows
        .filter((r) => r.status === 'met' || r.status === 'missed')
        .filter((r) => {
          const inputs = STANDS_ON[r.metric.toLowerCase()];
          if (inputs === undefined) return false;
          return inputs.some((field) => disownedFields.has(field))
            || inputs.includes('trade receivables');
        })
        .map((r) => r.metric);

      const actual = rows
        .filter((r) => r.footnote !== undefined
          && (notes.get(r.footnote) ?? '').startsWith('Scored on'))
        .map((r) => r.metric);

      expect(actual.sort()).toEqual(expected.sort());
    });
  }

  it('leaves some scored row alone, on a pack that has one to leave', () => {
    // The other direction of the set equality above: a guard that flagged
    // every scored row would satisfy it on Brightsphere, which scores exactly
    // one target and that one IS qualified. The demo scores three.
    const doc = buildBoardPackPages(liveDemoShortPanelsInput);
    const notes = scorecardFootnotes(doc);
    const scored = scorecardRows(doc).filter((r) => r.status === 'met' || r.status === 'missed');
    const flagged = scored.filter((r) => r.footnote !== undefined
      && (notes.get(r.footnote) ?? '').startsWith('Scored on'));
    expect(scored.length, 'the demo scores nothing, so nothing can be left alone').toBeGreaterThan(1);
    expect(flagged.length, 'every scored row on the demo is flagged').toBeLessThan(scored.length);
  });

  /**
   * THE MIRROR, ON A SHAPE NEITHER COMPANY HAS. Both packs happen to qualify
   * every scored ratio they carry, so removing the guard entirely leaves
   * their flagged sets unchanged — a mutation the composed-document tests
   * above cannot see. This is the row the flag must leave alone: a scored
   * metric in the table whose figures are sound.
   */
  it('leaves a scored ratio alone when the figures it stands on are sound', () => {
    const row = (metric: string): PackScorecardGroup['rows'][number] => ({
      metric,
      actual: { value: 3, format: 'ratio', source: 'x.y' },
      target: 1,
      prior: null,
      status: 'met',
      trend: null,
      trendSvg: null,
      bulletSvg: null,
    });
    const groups: PackScorecardGroup[] = [
      { letter: 'B', name: 'Liquidity', rows: [row('Cash ratio'), row('Current ratio')] },
    ];
    expect(disownedBases(groups, false, [])).toEqual([]);
    // And it still fires on the same shape once page 7 names one of them.
    expect(
      disownedBases(groups, false, [{ label: 'Current assets', amount: -1 }]).map((d) => d.metric),
    ).toEqual(['Current ratio']);
  });

  /**
   * THE OTHER STATE, WHICH NEITHER COMPOSED FIXTURE REACHES.
   *
   * Both packs put `trade receivables` in page 7's impossible set, so the
   * balance-sheet arm already selects every row the receivables arm would —
   * `receivablesUnreconciled` was passed `false` everywhere in this file and
   * hard-coding it false is green. The shape this is about is the ordinary
   * one: a sound balance sheet with an out-of-balance customer subledger,
   * which is page 4's debtors-base note firing on its own.
   *
   * It is also the only path to the third arm of the footnote. With both
   * states live the sentence says "which this pack qualifies elsewhere";
   * with only the balance sheet, "which the balance sheet says cannot be
   * held as stated". The unreconciled-only wording had no caller.
   */
  it('flags the receivables ratios alone when only page 4 disowns their base', () => {
    const row = (metric: string): PackScorecardGroup['rows'][number] => ({
      metric,
      actual: { value: 3, format: 'ratio', source: 'x.y' },
      target: 1,
      prior: null,
      status: 'met',
      trend: null,
      trendSvg: null,
      bulletSvg: null,
    });
    const groups: PackScorecardGroup[] = [
      { letter: 'B', name: 'Liquidity', rows: [row('Current ratio'), row('Cash ratio')] },
      { letter: 'C', name: 'Working capital', rows: [row('Debtor days'), row('Creditor days'), row('Cash conversion cycle')] },
    ];
    // Page 7 names nothing: the balance sheet is sound.
    const flagged = disownedBases(groups, true, []);
    expect(flagged.map((d) => d.metric)).toEqual(['Debtor days', 'Cash conversion cycle']);
    for (const base of flagged) {
      expect(base.unreconciled, `${base.metric} is not marked unreconciled`).toBe(true);
      expect(base.impossible, `${base.metric} claims the balance sheet disowns it`).toBe(false);
      expect(base.fields).toEqual(['trade receivables']);
    }
    // AND THE SENTENCE IS THE ONE THAT NAMES PAGE 4 — not the balance-sheet
    // wording, and not the both-states one. This is the sentence a tenant
    // with an out-of-balance subledger and a sound balance sheet prints.
    expect(disownedBasesFootnoteText(flagged)).toBe(
      'Scored on trade receivables, which the commentary page says is not reconciled; '
      + 'this pack does not adjust.',
    );
    // The mirror: with the flag off, the same rows carry nothing at all.
    expect(disownedBases(groups, false, [])).toEqual([]);
  });

  /**
   * AND THE THREE WORDINGS ARE THREE WORDINGS.
   *
   * One arm per state, and the balance-sheet arm reached for the receivables
   * one for a round because it was written as a shared clause. Asserting the
   * unreconciled sentence alone would pass a function that printed it for
   * every state.
   */
  it('says which page disowned the base, and the three states read differently', () => {
    const base = (impossible: boolean, unreconciled: boolean): Parameters<typeof disownedBasesFootnoteText>[0][number] => ({
      metric: 'Debtor days',
      fields: ['trade receivables'],
      impossible,
      unreconciled,
    });
    const unreconciledOnly = disownedBasesFootnoteText([base(false, true)])!;
    const impossibleOnly = disownedBasesFootnoteText([base(true, false)])!;
    const both = disownedBasesFootnoteText([base(true, true)])!;
    expect(unreconciledOnly).toContain('the commentary page says is not reconciled');
    expect(impossibleOnly).toContain('the balance sheet says cannot be held as stated');
    expect(both).toContain('this pack qualifies elsewhere');
    expect(new Set([unreconciledOnly, impossibleOnly, both]).size, 'two states print the same sentence').toBe(3);
    expect(disownedBasesFootnoteText([])).toBeNull();
  });

  /**
   * THE FOOTNOTE POINTS AT A STATEMENT PAGE 7 ACTUALLY MAKES.
   *
   * It used to re-derive the rule over its own field list, and that list held
   * `cash` and `inventory`: a company with an overdrawn bank was told on page
   * 9 that "the balance sheet says [cash] cannot be held as stated" while page
   * 7 — whose block is built from the asset and liability ROWS of the position
   * table — said nothing whatever about cash, and inventory is not printed in
   * the pack at all. Every field the footnote names must be one page 7 named,
   * or the receivables figure page 4 disowns.
   */
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`names only fields page 7 or page 4 states, on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const notes = [...scorecardFootnotes(doc).values()].filter((t) => t.startsWith('Scored on'));
      const said = page7Disowns(doc);
      expect(notes.length, 'no disowned-base footnote, so nothing is being checked')
        .toBeGreaterThan(0);
      for (const text of notes) {
        // `Scored on a, b and c, which …` — the field list is everything
        // before the relative clause that follows it.
        const list = text.replace(/^Scored on /, '').split(/, which /)[0] ?? '';
        const named = list.split(/, | and /).map((w) => w.trim()).filter((w) => w.length > 0);
        expect(named.length, `no fields parsed out of: ${text}`).toBeGreaterThan(0);
        for (const field of named) {
          expect(
            said.has(field) || field === 'trade receivables',
            `${company}: the footnote names "${field}" and page 7 states no such thing: ${text}`,
          ).toBe(true);
        }
      }
    });
  }

  /**
   * EVERY SCORED METRIC IS EITHER DECLARED OR DELIBERATELY UNDECLARED.
   *
   * `METRIC_INPUTS` is keyed on the printed metric name and an unknown key
   * fails OPEN — the row keeps its red MISS and loses its qualification with
   * no compile error. Renaming a metric in `packScorecard.ts` is a pure copy
   * edit; this makes it a red test instead of a silent loss.
   */
  it('declares inputs, or an explicit absence, for every scorecard metric', () => {
    const declared = new Set([...Object.keys(METRIC_INPUTS), ...NO_DECLARED_INPUTS]);
    for (const metric of SCORECARD_METRICS) {
      expect(
        declared.has(metric),
        `"${metric}" is in neither METRIC_INPUTS nor NO_DECLARED_INPUTS, so it can never be flagged`,
      ).toBe(true);
    }
    // And nothing is declared for a metric the scorecard no longer prints —
    // the other direction of the same rename.
    const printed = new Set(SCORECARD_METRICS);
    for (const metric of declared) {
      expect(printed.has(metric), `"${metric}" is declared here and no scorecard row prints it`).toBe(true);
    }
  });

  it('is not vacuous — both companies score a ratio on a balance below zero', () => {
    for (const [company, input] of Object.entries(COMPANIES)) {
      expect(input.set.current.currentAssets, `${company} has no negative current assets`).toBeLessThan(0);
      const scored = scorecardRows(buildBoardPackPages(input))
        .filter((r) => r.metric.toLowerCase() === 'current ratio' && (r.status === 'met' || r.status === 'missed'));
      expect(scored.length, `${company} does not score the current ratio`).toBe(1);
    }
  });
});
