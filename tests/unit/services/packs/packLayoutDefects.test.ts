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

describe('the comparative list names only measures printed against a comparative', () => {
  it('drops gross margin, and keeps the five that qualify', () => {
    const body = periodNote(liveDemoShortPanelsInput);
    expect(body, 'the trends page lost its Period note').not.toBeNull();
    expect(body).toMatch(/against the comparative/);
    expect(body, 'gross margin is named among measures printed against a comparative')
      .not.toMatch(/gross margin/i);
    for (const measure of ['revenue', 'operating expenses', 'net profit', 'cash', 'debtor days']) {
      expect(body, `the list stopped naming ${measure}`).toContain(measure);
    }
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

describe('a liability below zero gets the treatment a negative total gets', () => {
  const liabilityNote = (input: BoardPackInput): string | null => {
    for (const block of pageNamed(input, 'Balance sheet').blocks) {
      if (block.kind !== 'disclosure') continue;
      if (block.disclosure.heading !== 'A liability below zero') continue;
      return block.disclosure.notes.map((n) => n.body).join(' ');
    }
    return null;
  };

  it('names the row and says what a negative liability means', () => {
    const body = liabilityNote(brightsphereReceivablesGapInput);
    expect(body, 'the sheet prints a negative liability and says nothing').not.toBeNull();
    expect(body).toMatch(/Non-current liabilities/);
    expect(body).toMatch(/not an amount that can be owed/);
    expect(body).toMatch(/debit balances/);
    // Same shape as the other three impossibilities: it says the ledger is
    // reported as it stands rather than implying the pack corrected it.
    expect(body).toMatch(/reports the ledger as it stands/);
  });

  it('and the premise is on the page — a liability row below zero', () => {
    const block = pageNamed(brightsphereReceivablesGapInput, 'Balance sheet').blocks
      .find((b) => b.kind === 'table')!;
    const rows = block.kind === 'table' ? block.table.rows : [];
    const negative = rows.filter((r) => /liabilities$/i.test(r.label)
      && (r.figures.actual?.value ?? 0) < 0);
    expect(negative.length, 'no liability row is below zero on this fixture').toBeGreaterThan(0);
  });

  it('is silent where every liability is a liability', () => {
    expect(liabilityNote(demoInput)).toBeNull();
    expect(liabilityNote(liveDemoShortPanelsInput)).toBeNull();
  });
});
