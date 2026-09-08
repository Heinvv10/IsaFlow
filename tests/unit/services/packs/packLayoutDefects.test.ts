/**
 * THE TWO SENTENCES AND THE ONE BLOCK THAT CAME WITH THE LAYOUT ROUND.
 *
 * L3: the trends page's Period note says the same measures print "AGAINST THE
 * COMPARATIVE" and named gross margin among them — but page 6 prints gross
 * margin only in the ACTUAL `% OF REVENUE` column, which has no comparative
 * for any row. Five of the six named measures satisfied the sentence.
 *
 * L4: Brightsphere's balance sheet prints non-current liabilities of (424) —
 * an amount that cannot be owed — on the sheet that gives negative total
 * assets a titled block. The pack explained the impossibility at TOTAL level
 * and said nothing at COMPONENT level.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PERIOD_COUNTERPARTS } from '@/modules/accounting/services/packs/pages/packTrendCrossReference';
import { brightsphereReceivablesGapInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

function pageNamed(input: BoardPackInput, navLabel: string): PackPage {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === navLabel);
  if (page === undefined) throw new Error(`no ${navLabel} page`);
  return page;
}

function periodNote(input: BoardPackInput): string | null {
  for (const block of pageNamed(input, 'Trends').blocks) {
    if (block.kind !== 'disclosure') continue;
    const note = block.disclosure.notes.find((n) => n.heading === 'Period');
    if (note) return note.body;
  }
  return null;
}

describe('the comparative list accounts for every panel on the sheet', () => {
  it('names all six measures and states the one without a comparative', () => {
    // DROPPING gross margin was the previous round's fix and it traded a
    // wrong pointer for an incomplete enumeration: the note then mapped 5 of
    // the sheet's own 6 panels, while page 6's footnote 4 said from the other
    // end that the trends page plots that same measure monthly — and
    // Brightsphere's copy listed all 4 of its 4. True on one company, false
    // on the other.
    const body = periodNote(liveDemoShortPanelsInput);
    expect(body, 'the trends page lost its Period note').not.toBeNull();
    for (const measure of
      ['revenue', 'gross margin', 'operating expenses', 'net profit', 'cash', 'debtor days']) {
      expect(body, `the list does not account for ${measure}`).toContain(measure);
    }
    // And the exception is stated rather than left to be inferred from the
    // measure's absence.
    expect(body).toMatch(/all against the comparative but gross margin/);
  });

  it('claims the comparative without exception where every measure has one', () => {
    // Brightsphere draws four panels and all four print against a
    // comparative, so the sentence carries no exception clause at all.
    const body = periodNote(brightsphereReceivablesGapInput)!;
    expect(body).toMatch(/against the comparative/);
    expect(body).not.toMatch(/but gross margin/);
  });

  it('and page 6 really does print gross margin without one', () => {
    // The premise, asserted rather than assumed: the page has a prior column,
    // and the only place it states gross margin is a column that has none.
    const income = pageNamed(liveDemoShortPanelsInput, 'Income statement');
    const block = income.blocks.find((b) => b.kind === 'table')!;
    const table = block.kind === 'table' ? block.table : null;
    expect(table!.columns).toContain('prior');
    expect(table!.columns).toContain('pctOfRevenue');
    for (const row of table!.rows) {
      expect(row.figures.pctOfRevenue === undefined || row.figures.prior !== undefined).toBe(true);
    }
    // No row is labelled with the measure itself, which is why the note had
    // nothing on that page to point at.
    expect(table!.rows.map((r) => r.label.toLowerCase())).not.toContain('gross margin');
  });

  it('the flag is stated on every counterpart, not defaulted', () => {
    // The one measure it is false of is the one nobody checks, so every entry
    // has to answer the question.
    for (const [id, counterpart] of Object.entries(PERIOD_COUNTERPARTS)) {
      expect(typeof counterpart.printsAgainstComparative, `${id} does not state it`)
        .toBe('boolean');
    }
    expect(PERIOD_COUNTERPARTS['trend-gross-margin']!.printsAgainstComparative).toBe(false);
  });
});

/**
 * THE SIGN CHECK IS SYMMETRIC, OR IT IS AN ASYMMETRY WITH A BLOCK ATTACHED.
 *
 * The pack checked TOTAL assets and, after the round before this one,
 * COMPONENT liabilities. That is what let Brightsphere print `Non-current
 * liabilities (424)` WITH a headed block and `Current assets (3 372)` three
 * rows above with none: its total assets are positive, and the asset check
 * only ever looked at the total. The line that fell through was the largest
 * number that could have.
 */
describe('no impossible balance on the balance sheet goes unremarked', () => {
  const balancesNote = (input: BoardPackInput): string | null => {
    for (const block of pageNamed(input, 'Balance sheet').blocks) {
      if (block.kind !== 'disclosure') continue;
      if (block.disclosure.heading !== 'Balances below zero') continue;
      return block.disclosure.notes.map((n) => n.body).join(' ');
    }
    return null;
  };

  /** Every asset or liability line the sheet prints below zero. */
  const impossibleRows = (input: BoardPackInput): string[] => {
    const block = pageNamed(input, 'Balance sheet').blocks.find((b) => b.kind === 'table')!;
    const rows = block.kind === 'table' ? block.table.rows : [];
    return rows
      .filter((r) => /assets$|liabilities$/i.test(r.label) && (r.figures.actual?.value ?? 0) < 0)
      .map((r) => r.label);
  };

  it.each([
    ['Brightsphere', brightsphereReceivablesGapInput],
    ['the live demo company', liveDemoShortPanelsInput],
  ])('names every impossible line on %s, whichever side it is', (unusedName, input) => {
    const rows = impossibleRows(input);
    expect(rows.length, 'this fixture has no impossible balance to remark on')
      .toBeGreaterThan(0);
    const body = balancesNote(input);
    expect(body, 'the sheet prints a balance below zero and says nothing').not.toBeNull();
    for (const label of rows) {
      // Case-insensitive: the sentence lower-cases every label but the first.
      expect(body!.toLowerCase(), `the note does not name ${label}`)
        .toContain(label.toLowerCase());
    }
    expect(body).toMatch(/reports the ledger as it stands/);
  });

  it('covers component and total, asset side and liability side', () => {
    // The four positions, on the two fixtures between them: Brightsphere has
    // a negative asset COMPONENT and a negative liability COMPONENT; the demo
    // has negative asset components AND a negative asset TOTAL. A check that
    // looked at totals only, or at one side only, fails one of these.
    expect(impossibleRows(brightsphereReceivablesGapInput)).toEqual(
      expect.arrayContaining(['Current assets', 'Non-current liabilities']),
    );
    expect(impossibleRows(liveDemoShortPanelsInput)).toEqual(
      expect.arrayContaining(['Current assets', 'Total assets']),
    );
  });

  it('says which kind of impossibility it is', () => {
    // One side named as that side; both sides named once, not twice.
    expect(balancesNote(liveDemoShortPanelsInput))
      .toMatch(/accounts classified as assets carry credit balances/);
    expect(balancesNote(brightsphereReceivablesGapInput))
      .toMatch(/carry balances contrary to the band they are classified in/);
  });

  it('is silent where every balance carries the sign it can', () => {
    expect(balancesNote(demoInput)).toBeNull();
  });
});
