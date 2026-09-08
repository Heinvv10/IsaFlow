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
  RECEIVABLES_RECONCILIATION_HEADING,
  receivablesReconciliationNote,
} from '@/modules/accounting/services/packs/pages/packReceivablesReconciliation';
import {
  brightsphereReceivablesGapInput,
  demoInput,
  demoSet,
} from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { MATTERS_NAV_LABEL } from '@/modules/accounting/services/packs/pages/packMattersPage';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

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
    expect(body).toMatch(/does not reconcile them/);
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
    expect(demoInput.agedDebtorsTotal).toBe(demoSet.current.accountsReceivable);
    expect(reconciliationBody(mattersPage(demoInput))).toBeNull();
  });

  it('prints nothing where no sheet states an aged debtors total', () => {
    // The live demo company's largest debtor is 17.8% of its book, under the
    // concentration threshold, so `buildMatters` raises no aged-debtor matter
    // and the pack prints ONE debtors figure. Its books disagree with the
    // subledger by R10.7m and no sheet says so, because no sheet claims
    // otherwise — a disclosure about a figure the pack does not print is the
    // pack answering a question it has not raised.
    expect(liveDemoRenderedInput.agedDebtorsTotal).toBeNull();
    expect(reconciliationBody(mattersPage(liveDemoRenderedInput))).toBeNull();
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
    const block = receivablesReconciliationNote(aging, control, PACK_SCALE);
    const body = block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body : '';

    for (const printed of expected) {
      expect(body, `the note does not state ${printed}`).toMatch(figure(printed));
    }
    // The same sentences either way round: the demo's control account is a
    // DEBIT holding 0.6% of its subledger and Brightsphere's is a CREDIT, and
    // the disclosure is the same disclosure about the same pair of sources.
    expect(body).toMatch(/do not agree/);
    expect(body).toMatch(/does not reconcile them/);
  });

  it('names no company and no counterparty', () => {
    const bodies = TENANTS.map(([, aging, control]) => {
      const block = receivablesReconciliationNote(aging, control, PACK_SCALE);
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
    const block = receivablesReconciliationNote(4_145_971.5, -329_700, PACK_SCALE);
    expect(block?.kind === 'disclosure'
      ? block.disclosure.notes[0]!.body : '').toMatch(figure('4 476'));

    const mirrored = receivablesReconciliationNote(4_145_971.5, 329_700, PACK_SCALE);
    expect(mirrored?.kind === 'disclosure'
      ? mirrored.disclosure.notes[0]!.body : '').toMatch(figure('3 816'));
  });

  it('is silent on a difference too small to print at the pack\'s scale', () => {
    // R40 of difference prints as a dash in R'000. A note stating a
    // difference a reader cannot see on the sheet reads as an error.
    expect(receivablesReconciliationNote(720_040, 720_000, PACK_SCALE)).toBeNull();
    expect(receivablesReconciliationNote(720_000, 720_000, PACK_SCALE)).toBeNull();
  });

  it('is silent where the pack prints no aged debtors total at all', () => {
    expect(receivablesReconciliationNote(null, -329_700, PACK_SCALE)).toBeNull();
  });
});
