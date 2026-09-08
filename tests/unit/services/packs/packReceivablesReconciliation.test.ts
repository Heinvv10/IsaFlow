/**
 * TWO DEBTORS FIGURES, AND THE SHEET THAT MAKES THE CLAIM HAS TO CARRY THE
 * DIFFERENCE.
 *
 * The live client pack asked a board to decide whether to refer a NAMED
 * counterparty's account for write-off, on the strength of an aged debtors
 * report totalling 4 146, printed facing a balance sheet stating trade
 * receivables of (330). Nothing anywhere in the twelve sheets said the two
 * were different figures, let alone that they differ by more than either of
 * them. The round before this one named the sources in the matter's own
 * sentence and a blind gate refused the pack anyway, correctly: naming two
 * sources explains why two figures MIGHT differ and says nothing about why
 * THESE two differ by 4 476.
 *
 * These hold both directions. A pack whose subledger and control account
 * agree must not print a reconciliation — page 11's paper is matters rows —
 * and a pack whose figures disagree must not be able to reach a reader
 * without one.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import {
  RECEIVABLES_BASE_HEADING,
  RECEIVABLES_RECONCILIATION_HEADING,
  receivablesBaseNote,
  receivablesReconciliationNote,
  type PackReceivablesRead,
} from '@/modules/accounting/services/packs/pages/packReceivablesReconciliation';
import {
  brightsphereReceivablesGapInput,
  demoInput,
  demoSet,
} from './fixtures/boardPackInputs';
import { liveDemoRenderedInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import { MATTERS_NAV_LABEL } from '@/modules/accounting/services/packs/pages/packMattersPage';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { ReconcilingItem } from '@/modules/accounting/services/reconciliation/reconcilingItemTypes';

/**
 * A receivables read with NO decomposition — the shape the pack composes when
 * `reconcileSubledger` could not be reached, and the one most of these
 * assertions are about. `subledgerTotal` mirrors the aged total so the
 * bridge's first leg has nothing to say.
 */
function read(agedDebtorsTotal: number | null, controlBalance: number): PackReceivablesRead {
  return {
    agedDebtorsTotal,
    subledgerTotal: agedDebtorsTotal,
    controlBalance,
    items: [],
    unexplained: 0,
  };
}

/** A printed figure, whatever character the formatter grouped it with. */
function figure(text: string): RegExp {
  return new RegExp(text.replace(/[()]/g, '\\$&').replace(/ /g, '[\\s\\u202f\\u00a0]'));
}

function mattersPage(input: BoardPackInput): PackPage {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === MATTERS_NAV_LABEL);
  if (page === undefined) throw new Error('the pack has no matters page');
  return page;
}

function reconciliationBody(page: PackPage): string | null {
  for (const block of page.blocks) {
    if (block.kind !== 'disclosure') continue;
    if (block.disclosure.heading !== RECEIVABLES_RECONCILIATION_HEADING) continue;
    return block.disclosure.notes.map((n) => n.body).join(' ');
  }
  return null;
}

describe('the two debtors figures are reconciled on the sheet that prints them', () => {
  it('states both figures and their difference on the live client shape', () => {
    const body = reconciliationBody(mattersPage(brightsphereReceivablesGapInput));

    expect(body, 'page 11 carries no reconciliation of its two debtors figures').not.toBeNull();
    // The aged debtors report's total, the balance sheet's trade receivables,
    // and 4 145 971.50 − (329 700) = 4 475 671.50. All three as the sheet
    // prints them, so the subtraction is one a director can take off the
    // paper.
    // Matched through `figure`, not as literals: the pack groups thousands
    // with a narrow no-break space (U+202F) that `Intl` gives en-ZA, and a
    // test typing an ordinary space asserts against a string the pack has
    // never printed.
    expect(body).toMatch(figure('4 146'));
    expect(body).toMatch(figure('(330)'));
    expect(body).toMatch(figure('4 476'));
  });

  it('says the two do not agree and that this pack does not reconcile them', () => {
    const body = reconciliationBody(mattersPage(brightsphereReceivablesGapInput))!;

    // NOT "they are measured differently", which is the sentence the round
    // before this one wrote and which reads as reassurance. The difference is
    // unexplained and the note has to say so, because the decision the
    // concentration matter above asks for rests on one of the two figures.
    expect(body).toMatch(/do not agree/);
    // NOT "does not reconcile them", which is what this said before the pack
    // learned to decompose the difference. It now DOES partly reconcile them
    // — that is what the itemisation is — and what it declines to do is move
    // either balance. Asserting the old wording would hold the pack to a
    // claim that has stopped being true.
    expect(body).toMatch(/does not adjust either figure to the other/);
    expect(body).toMatch(/should be explained before/);
    // And it names which figure comes from which source, because a reader
    // whose next question is "so which one is our debtors balance" needs to
    // know what each one measures.
    expect(body).toMatch(/subledger/);
    expect(body).toMatch(/control account/);
  });

  it('states no cause, because the pack has not measured one', () => {
    const body = reconciliationBody(mattersPage(brightsphereReceivablesGapInput))!;

    // The cause on the live client ledger is that no customer invoice was
    // ever posted to the control account and the balance is reversal residue
    // — read off one database on one day. A sentence generalising that would
    // be the same mistake as the wording it replaces, one level of confidence
    // further on.
    for (const guess of [/unapplied/i, /credit note/i, /timing/i, /not yet posted/i, /reversal/i]) {
      expect(body, `the note explains a cause it did not measure: ${guess}`).not.toMatch(guess);
    }
  });

  it('prints nothing where the two figures agree', () => {
    // `demoInput`'s concentration matter states a base of 720 in R'000 and
    // `demoSet.current.accountsReceivable` is 720 000: one company, one
    // debtors balance, nothing to reconcile.
    expect(demoInput.receivables.agedDebtorsTotal).toBe(demoSet.current.accountsReceivable);
    expect(reconciliationBody(mattersPage(demoInput))).toBeNull();
  });

  // A RULING REVERSED, AND THE PACK IS WHAT REVERSED IT.
  //
  // This asserted the opposite: the demo pack prints no aged-debtors total,
  // so a disclosure about a figure no sheet states was held to be the pack
  // answering a question it had not raised. Sheet 9 now prints
  // `Debtor days · 213 · target 30 · MISSED` in red, and sheet 4 says the
  // ratio is taken on a base it disowns — "read the day count as a measure of
  // the control account, not of what customers owe". A red MISS is a printed
  // judgement, and the conflict a reader can see is between that judgement
  // and a caveat one page earlier. The block bridges from whichever debtors
  // figure the pack has.
  it('reconciles the subledger where no aged debtors total is printed', () => {
    expect(liveDemoRenderedInput.receivables.agedDebtorsTotal).toBeNull();
    const body = reconciliationBody(mattersPage(liveDemoRenderedInput));
    expect(body, 'the demo pack states its R10.7m gap nowhere on the matters page').not.toBeNull();
    // It bridges from the SUBLEDGER, and names it — a heading about an aged
    // report over a sentence about the subledger is a pointer to a report
    // this pack never read.
    expect(body).toMatch(/open customer subledger totals/);
    expect(body, 'it claims an aged report the pack has no total for').not.toMatch(/aged debtors report/);
  });

  it('is budgeted against the table rather than appended after it', () => {
    // The note is subtracted from the matters budget BEFORE the selection
    // runs, so the page still composes inside one sheet and does not
    // apologise for its own layout. Appended after the selection it would be
    // paper page 11 had already spent.
    const page = mattersPage(brightsphereReceivablesGapInput);
    expect(page.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)),
      'page 11 apologised for its layout rather than budgeting the reconciliation').toBe(false);
    // And it costs a row, which is the trade the design makes deliberately:
    // the tail states its own count, so nothing is withheld silently.
    const table = page.blocks.find((b) => b.kind === 'matters')!;
    expect(table.kind === 'matters' ? table.omitted?.count ?? 0 : 0).toBeGreaterThan(0);
  });
});

/**
 * THE PROSE IS NOT ABOUT BRIGHTSPHERE.
 *
 * The finding was made on the live client ledger and every figure in the
 * module's docblock is that company's, which is exactly the condition under
 * which a sentence quietly becomes about one tenant. Both dev tenants have
 * the same shape — an AR subledger the general ledger does not reflect — at
 * two very different magnitudes and with the control account on OPPOSITE
 * SIDES: Brightsphere's is a credit of R329 700 and the demo's a debit of
 * R59 240 holding half a per cent of what the subledger says is owed.
 *
 * These run the note over both, and assert what a company-neutral disclosure
 * has to be: it states THEIR figures, and it names no company, no
 * counterparty, and no cause.
 */
describe('the note is written for any company with two debtors figures', () => {
  // Read off `isaflow_dev` at 7 September 2026 through `getAgingReport(...)`
  // and `buildPackFigureSet(...)` — the same two calls the pack makes.
  const TENANTS = [
    // aging total, control balance, and the three figures the note prints.
    ['Brightsphere', 4_145_971.5, -329_700, ['4 146', '(330)', '4 476']],
    ['the demo company', 10_724_260.43, 59_240, ['10 724', '59', '10 665']],
  ] as const;

  it.each(TENANTS)('%s', (unusedName, aging, control, expected) => {
    const block = receivablesReconciliationNote(read(aging, control), control, PACK_SCALE);
    const body = block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body : '';

    for (const printed of expected) {
      expect(body, `the note does not state ${printed}`).toMatch(figure(printed));
    }
    // The same sentences either way round: the demo's control account is a
    // DEBIT holding 0.6% of its subledger and Brightsphere's is a CREDIT, and
    // the disclosure is the same disclosure about the same pair of sources.
    expect(body).toMatch(/do not agree/);
    expect(body).toMatch(/does not adjust either figure to the other/);
  });

  it('names no company and no counterparty', () => {
    const bodies = TENANTS.map(([, aging, control]) => {
      const block = receivablesReconciliationNote(read(aging, control), control, PACK_SCALE);
      return block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body : '';
    });
    for (const body of bodies) {
      for (const name of [/Brightsphere/i, /Blitz/i, /ISAFlow/i, /demo/i]) {
        expect(body, `the disclosure names a party: ${name}`).not.toMatch(name);
      }
    }
    // And the two differ ONLY in their figures — same words, same order.
    const stripped = bodies.map((b) => b.replace(/[\d\s\u202f\u00a0()]+/g, ' '));
    expect(stripped[0]).toBe(stripped[1]);
  });
});

describe('receivablesReconciliationNote takes its difference in the right direction', () => {
  it('is the aged debtors total LESS the control balance', () => {
    // Signed, not absolute: a control account carrying a credit makes the
    // difference LARGER than the aging total, and a note that added the two
    // or took a magnitude would print the same 4 476 for a company whose
    // control account held 4 476 of receivables the subledger has never heard
    // of. Those are opposite findings.
    const block = receivablesReconciliationNote(read(4_145_971.5, -329_700), -329_700, PACK_SCALE);
    expect(block?.kind === 'disclosure'
      ? block.disclosure.notes[0]!.body : '').toMatch(figure('4 476'));

    const mirrored = receivablesReconciliationNote(read(4_145_971.5, 329_700), 329_700, PACK_SCALE);
    expect(mirrored?.kind === 'disclosure'
      ? mirrored.disclosure.notes[0]!.body : '').toMatch(figure('3 816'));
  });

  it('is silent on a difference too small to print at the pack\'s scale', () => {
    // R40 of difference prints as a dash in R'000. A note stating a
    // difference a reader cannot see on the sheet reads as an error.
    expect(receivablesReconciliationNote(read(720_040, 720_000), 720_000, PACK_SCALE)).toBeNull();
    expect(receivablesReconciliationNote(read(720_000, 720_000), 720_000, PACK_SCALE)).toBeNull();
  });

  it('is silent where the pack prints no aged debtors total at all', () => {
    expect(receivablesReconciliationNote(read(null, -329_700), -329_700, PACK_SCALE)).toBeNull();
  });
});

/**
 * WHAT THE DIFFERENCE CONSISTS OF.
 *
 * "A difference of 4 476, unreconciled" tells a board there is a problem and
 * gives them no first question. `reconcileSubledger` has always been able to
 * say that 4 175 of it is 29 open documents carrying no link to a journal
 * entry and 320 is 98 postings referencing no document — nothing connected it
 * to the pack.
 *
 * The arithmetic hazard these exist for: the ITEMS decompose the gap between
 * the SUBLEDGER and the control account, and the sentence above them states
 * the gap between the AGED REPORT and the control account. On the live client
 * those differ by the 19 of documents that carry no due date, so a list
 * printed against the wrong base fails to add up by 19 — on the one sheet in
 * the pack whose purpose this round is to make two figures add up.
 */
describe('the reconciliation states what the difference consists of', () => {
  const ITEMS = [
    {
      bridge: 'subledger_to_control' as const,
      type: 'document_not_linked_to_journal',
      description: 'unused',
      amount: 4_174_721.5,
      documentIds: Array.from({ length: 29 }, (unused, i) => `doc-${i}`),
      documentNumbers: [],
    },
    {
      bridge: 'subledger_to_control' as const,
      type: 'posting_with_no_document',
      description: 'unused',
      amount: 319_700,
      documentIds: Array.from({ length: 98 }, (unused, i) => `je-${i}`),
      documentNumbers: [],
    },
  ];
  const LIVE: PackReceivablesRead = {
    agedDebtorsTotal: 4_145_971.5,
    subledgerTotal: 4_164_721.5,
    controlBalance: -329_700,
    items: ITEMS,
    unexplained: 0,
  };
  const body = (r: PackReceivablesRead = LIVE): string => {
    const block = receivablesReconciliationNote(r, -329_700, PACK_SCALE);
    return block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body : '';
  };

  it('names each item with its amount AND its population', () => {
    expect(body()).toMatch(figure('4 175'));
    expect(body()).toMatch(/across 29 open documents carrying no link to a journal entry/);
    expect(body()).toMatch(figure('320'));
    expect(body()).toMatch(/across 98 postings that reference no document/);
  });

  it('states the SUBLEDGER as the base the items decompose, and bridges to it', () => {
    // Without this leg the list is 4 495 against a stated difference of
    // 4 476 and nothing on the sheet accounts for the 19.
    expect(body()).toMatch(figure('4 165'));
    expect(body()).toMatch(/documents with no due date, which reach no aging bucket/);
    // And the arithmetic closes: the items sum to the gap they are said to
    // decompose, on the figures as printed.
    const gap = LIVE.subledgerTotal! - LIVE.controlBalance!;
    expect(ITEMS.reduce((s, i) => s + i.amount, 0)).toBeCloseTo(gap, 2);
  });

  it('prints no difference figure its own components cannot reach', () => {
    // It stated "Of the 4 494 between that subledger and the control
    // account, 4 175 … and 320 …" — and 4 175 + 320 is 4 495. Both were
    // right: the raw components sum to the raw gap exactly, and the two
    // components each round UP while the gap rounds down. A stated total its
    // own components do not add to is the one thing this sheet exists not to
    // do, on the round whose whole subject is two figures that must add up.
    //
    // So no gap figure is printed, and every relation on the block closes on
    // its face instead: 4 146 against (330) is the stated 4 476; 4 146 plus
    // 19 is the stated subledger of 4 165; and 4 165 against (330) is 4 495,
    // which is what the two components add to.
    const text = body();
    expect(text).not.toMatch(figure('4 494'));
    const printed = (n: number) => Math.round(n / 1_000);
    expect(ITEMS.reduce((s, i) => s + printed(i.amount), 0))
      .toBe(printed(LIVE.subledgerTotal!) - printed(LIVE.controlBalance!));
  });

  it('drops the aging leg where every document can be aged', () => {
    // A company whose report ages its whole subledger has no 19 to explain,
    // and a clause explaining a difference of nothing is noise on the page
    // that can least afford it.
    const whole = body({ ...LIVE, agedDebtorsTotal: 4_164_721.5 });
    expect(whole).toMatch(/ages the whole of an open customer subledger/);
    expect(whole).not.toMatch(/reach no aging bucket/);
  });

  it('states no cause, still', () => {
    for (const guess of [/because/i, /unapplied cash/i, /error/i, /should have been posted/i]) {
      expect(body(), `the decomposition explains a cause: ${guess}`).not.toMatch(guess);
    }
  });

  it('refuses itself rather than introducing a third receivables figure', () => {
    // `reconcileSubledger` reads the control account through
    // `getControlAccountBalances` and the balance sheet through
    // `aggregateFigures`. Where those disagree, the items describe a gap that
    // is not the gap the sentence states, and the honest answer is the
    // shorter note — which must still name both sources.
    const mismatched = body({ ...LIVE, controlBalance: -300_000 });
    expect(mismatched).not.toMatch(/across 29 open documents/);
    expect(mismatched).toMatch(/the first is the open customer subledger/i);
    expect(mismatched).toMatch(figure('4 476'));
  });

  it('falls back to the shorter note when the reconciliation could not be read', () => {
    for (const broken of [
      { ...LIVE, items: [] },
      { ...LIVE, subledgerTotal: null },
      { ...LIVE, controlBalance: null },
    ]) {
      const text = body(broken);
      expect(text).not.toMatch(/across 29 open documents/);
      expect(text).toMatch(/the first is the open customer subledger/i);
    }
  });

  it('carries a residual the service could not account for, rather than dropping it', () => {
    // The most important item in the list is the one that says the list is
    // incomplete. A lookup that silently skips an unknown type would drop
    // exactly that one.
    const withResidual = body({
      ...LIVE,
      items: [...ITEMS, {
        bridge: 'subledger_to_control' as const,
        type: 'unexplained_difference',
        description: 'unused',
        amount: 250_000,
        documentIds: [],
        documentNumbers: [],
      }],
    });
    expect(withResidual).toMatch(/250 left over, which this reconciliation could not account for/);
  });
});

/**
 * THE RATIO THAT WAS ARITHMETICALLY CORRECT AND ECONOMICALLY MEANINGLESS.
 *
 * Page 7's memorandum prints trade receivables and pages 3 and 9 derive
 * debtor days from it — and that figure is the trade-receivable CONTROL
 * ACCOUNT, which on the live demo company holds 0.6% of what the subledger
 * says customers owe. 213 days looks like an ordinary measurement and reads
 * as one. This is the debtors defect one step downstream and the more
 * dangerous half, because page 11's contradiction is at least visible.
 *
 * The pack discloses the base. It does NOT reprice the ratio: recomputing
 * debtor days off the subledger changes a printed figure on a judgement about
 * which balance is the right numerator, and that is not a rendering decision.
 */
describe('the pack says which debtors balance debtor days is taken on', () => {
  const READ: PackReceivablesRead = {
    agedDebtorsTotal: null,
    subledgerTotal: 10_724_260.43,
    controlBalance: 59_240,
    items: [],
    unexplained: 0,
  };
  const body = (r: PackReceivablesRead, control: number, measured = true): string => {
    const block = receivablesBaseNote(r, control, PACK_SCALE, measured);
    return block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body : '';
  };

  it('names the base, the other reading, and what the day count therefore measures', () => {
    const text = body(READ, 59_240);
    expect(text).toMatch(figure('59'));
    expect(text).toMatch(/trade-receivable control account in the general ledger/);
    expect(text).toMatch(figure('10 724'));
    expect(text).toMatch(/open customer subledger/);
    expect(text).toMatch(/a measure of the control account, not of what customers owe/);
  });

  it('does not reprice the ratio, and says so', () => {
    expect(body(READ, 59_240)).toMatch(/does not recompute the ratio on the other base/);
  });

  it('is silent where the scorecard states no day count', () => {
    // Brightsphere's revenue is not a positive base and its scorecard prints
    // a reason in place of debtor days. Qualifying a measure the pack does
    // not state is a page naming a chart the pack does not draw.
    expect(receivablesBaseNote(READ, 59_240, PACK_SCALE, false)).toBeNull();
  });

  it('is silent where the two readings agree at the pack\'s scale', () => {
    expect(receivablesBaseNote(
      { ...READ, subledgerTotal: 59_280 }, 59_240, PACK_SCALE, true,
    )).toBeNull();
  });

  it('is silent where the subledger could not be read at all', () => {
    expect(receivablesBaseNote(
      { ...READ, subledgerTotal: null }, 59_240, PACK_SCALE, true,
    )).toBeNull();
  });
});

describe('the debtors-base note reaches the page a board reads first', () => {
  const narrativeNotes = (input: BoardPackInput): string => {
    const page = buildBoardPackPages(input).pages
      .find((p) => p.navLabel === 'Commentary and actions')!;
    return page.blocks
      .filter((b) => b.kind === 'disclosure' && b.disclosure.heading === RECEIVABLES_BASE_HEADING)
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
      .join(' ');
  };

  it('prints on the live demo shape, whose control account is a fraction of its subledger', () => {
    // Page 7 is where this belongs and it has 1.93mm on this company against
    // a 3.88mm line — no room for a word, let alone a block. Page 4 has
    // 85.86mm, is prose by specification, and is the first sheet read.
    expect(narrativeNotes(liveDemoRenderedInput)).toMatch(/trade-receivable control account/);
    expect(narrativeNotes(liveDemoRenderedInput)).toMatch(/open customer subledger/);
  });

  it('does not print where the pack\'s two receivables readings agree', () => {
    // `demoInput`'s subledger IS its control account, so there is no base to
    // disclose and page 4 says nothing.
    expect(narrativeNotes(demoInput)).toBe('');
  });

  it('costs no sheet its layout', () => {
    for (const input of [liveDemoRenderedInput, demoInput, brightsphereReceivablesGapInput]) {
      const page = buildBoardPackPages(input).pages
        .find((p) => p.navLabel === 'Commentary and actions')!;
      expect(page.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)),
        'page 4 apologised for its layout').toBe(false);
    }
  });
});

/**
 * THE ONE n/m IN THE PACK THAT CARRIED NO LETTERED REASON.
 *
 * Page 11's QUANTUM column prints `n/m` on every matter with no single rand
 * amount — the overdue AFS filings, on both companies — and the reason was
 * attached to the figure all along. `MattersTable` never collected it, so the
 * pack's own convention ("the reason is always one lettered mark away") held
 * everywhere except the governance page.
 */
describe('the matters page\'s n/m carries its reason like every other', () => {
  it('attaches a reason to every unquantified matter, on both companies', () => {
    for (const input of [liveDemoShortPanelsInput, brightsphereReceivablesGapInput]) {
      const page = buildBoardPackPages(input).pages
        .find((p) => p.navLabel === MATTERS_NAV_LABEL)!;
      const block = page.blocks.find((b) => b.kind === 'matters')!;
      const rows = block.kind === 'matters' ? block.matters : [];
      const unquantified = rows.filter((m) => m.quantum.value === null);
      expect(unquantified.length, 'no unquantified matter prints on this pack')
        .toBeGreaterThan(0);
      for (const matter of unquantified) {
        expect(matter.quantum.unavailable,
          'an n/m with no reason, on the one page that had them').toBeTruthy();
      }
    }
  });

  it('and the page reserves the paper that note takes', () => {
    // Charging for the note without reserving it took page 11 of the live
    // demo pack over its box, and `fitPageToBox` paid by dropping the "What
    // was checked" disclosure — the page acquired a reason for its n/m and
    // apologised for its own layout in the same breath.
    for (const input of [liveDemoShortPanelsInput, brightsphereReceivablesGapInput]) {
      const page = buildBoardPackPages(input).pages
        .find((p) => p.navLabel === MATTERS_NAV_LABEL)!;
      expect(page.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)),
        'page 11 apologised for its layout').toBe(false);
      expect(page.blocks.some((b) => b.kind === 'disclosure'
        && b.disclosure.heading === 'What was checked'),
      'page 11 dropped the disclosure that answers what was checked').toBe(true);
    }
  });
});

/**
 * K1 — TWO CORRECT RULINGS THAT COLLIDED.
 *
 * The debtors-base note fires wherever debtor days is measured and the two
 * readings differ; page 11's reconciliation fires only where a sheet PRINTS
 * an aged debtors total. On the demo those conditions come apart, and page 4
 * said "the matters page sets out what the difference consists of" over a
 * matters page carrying no such section. A pointer to a page that does not
 * carry the thing is the defect a director catches live in the meeting.
 */
describe('the debtors-base note points at page 11 only where page 11 carries it', () => {
  const baseNote = (input: BoardPackInput): string => {
    const page = buildBoardPackPages(input).pages
      .find((p) => p.navLabel === 'Commentary and actions')!;
    return page.blocks
      .filter((b) => b.kind === 'disclosure' && b.disclosure.heading === RECEIVABLES_BASE_HEADING)
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
      .join(' ');
  };

  it('makes the cross-reference on the demo too, now that its matters page carries one', () => {
    const text = baseNote(liveDemoShortPanelsInput);
    expect(text, 'the demo pack stopped stating its debtors base').not.toBe('');
    expect(text).toMatch(figure('10 724'));
    expect(text).toMatch(/matters page/);
    // And the page it points at really does carry it — which is the half that
    // was false when this test asserted the opposite.
    const matters = buildBoardPackPages(liveDemoShortPanelsInput).pages
      .find((p) => p.navLabel === MATTERS_NAV_LABEL)!;
    expect(matters.blocks.some((b) => b.kind === 'disclosure'
      && b.disclosure.heading === RECEIVABLES_RECONCILIATION_HEADING)).toBe(true);
  });

  it('makes the cross-reference where the matters page does carry it', () => {
    // Brightsphere prints an aged debtors total, so page 11 reconciles the
    // two figures and the pointer resolves. Same note, opposite company.
    const withGap: BoardPackInput = {
      ...brightsphereReceivablesGapInput,
      set: {
        ...brightsphereReceivablesGapInput.set,
        current: { ...brightsphereReceivablesGapInput.set.current, revenue: 5_000_000 },
      },
    };
    const text = baseNote(withGap);
    if (text === '') return; // debtor days not measurable on this shape
    expect(text).toMatch(/matters page sets out what the difference consists of/);
    const matters = buildBoardPackPages(withGap).pages.find((p) => p.navLabel === MATTERS_NAV_LABEL)!;
    expect(matters.blocks.some((b) => b.kind === 'disclosure'
      && b.disclosure.heading === RECEIVABLES_RECONCILIATION_HEADING)).toBe(true);
  });

  it('the pointer tracks the page, not the company', () => {
    // The condition is asked of page 11's own builder, so the two cannot come
    // apart: the clause is present exactly when that block prints. It used to
    // be a second copy of the builder's gate, and stopped being the same
    // condition the moment the block learned to bridge from the subledger.
    const withTotal = receivablesBaseNote(
      { agedDebtorsTotal: 4_145_971.5, subledgerTotal: 4_164_721.5, controlBalance: -329_700, items: [], unexplained: 0 },
      -329_700, PACK_SCALE, true,
    );
    // No subledger and no aged total: page 11 reconciles nothing, so the
    // pointer must not resolve.
    const without = receivablesBaseNote(
      { agedDebtorsTotal: null, subledgerTotal: null, controlBalance: 59_240, items: [], unexplained: 0 },
      59_240, PACK_SCALE, true,
    );
    // And the demo's shape — a subledger but no aged report — now DOES carry
    // the block, so the pointer resolves there too.
    const subledgerOnly = receivablesBaseNote(
      { agedDebtorsTotal: null, subledgerTotal: 10_724_260.43, controlBalance: 59_240, items: [], unexplained: 0 },
      59_240, PACK_SCALE, true,
    );
    const body = (b: typeof withTotal) => (b?.kind === 'disclosure' ? b.disclosure.notes[0]!.body : '');
    expect(body(withTotal)).toMatch(/matters page/);
    expect(body(without)).not.toMatch(/matters page/);
    expect(body(subledgerOnly)).toMatch(/matters page/);
  });
});

/**
 * A LIST OF PARTS IS NOT A PROOF UNTIL THE SHEET SAYS IT IS ALL OF THEM.
 *
 * Brightsphere's block names 4 175 across 29 unlinked documents and 320
 * across 98 postings that reference no document — and those two ARE the whole
 * difference between the subledger and the control account. The page listed
 * them and stopped, so a director could not tell an itemisation from a
 * sample.
 *
 * It is conditional on nothing being left over: `unexplained_difference` is
 * one of the service's own reconciling types and carries its own clause, and
 * a list containing it still sums to the difference — so the closure would be
 * arithmetically true while telling a reader the opposite of what that clause
 * says.
 */
describe('the decomposition says whether it closes', () => {
  const items = (types: string[]): ReconcilingItem[] => types.map((type, i) => ({
    bridge: 'subledger_to_control',
    type,
    amount: 100_000 * (i + 1),
    description: type,
    documentIds: ['a', 'b'],
    documentNumbers: [],
  } as unknown as ReconcilingItem));

  /** The note's prose, which the builder returns as a disclosure block. */
  const prose = (types: string[]): string => {
    const block = receivablesReconciliationNote(read(types), -330_000, PACK_SCALE);
    expect(block, 'no reconciliation block was built').not.toBeNull();
    return block!.kind === 'disclosure' ? block!.disclosure.notes.map((n) => n.body).join(' ') : '';
  };

  const read = (types: string[]): PackReceivablesRead => ({
    agedDebtorsTotal: 4_146_000,
    subledgerTotal: 4_165_000,
    controlBalance: -330_000,
    items: items(types),
    unexplained: null,
  });

  it('says the parts are all of it when nothing is left over', () => {
    expect(prose(['document_not_linked_to_journal', 'posting_with_no_document']))
      .toContain('Together they account for all of it, before rounding.');
  });

  // AND IT SAYS AT WHICH PRECISION. The demo's printed split is
  // 10 665 + 2 + (1) = 10 666 against a stated difference of 10 665 — inside
  // the rounding the pack declares, but this sentence makes an explicit
  // CLOSURE claim on its own face, and a closure claim that does not close by
  // one is a different thing from a page without a pointer.
  it('says nothing of the sort when the service could not account for a residual', () => {
    const note = prose(['document_not_linked_to_journal', 'unexplained_difference']);
    expect(note).toContain('could not account for');
    expect(note, 'the block claims a closure over an item that is explicitly not closed')
      .not.toMatch(/account for all of it/);
  });

  it('agrees its verb with one part', () => {
    expect(prose(['posting_with_no_document'])).toContain('That accounts for all of it, before rounding.');
  });
});
