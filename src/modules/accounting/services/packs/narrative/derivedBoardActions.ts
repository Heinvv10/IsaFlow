/**
 * Page 4's board-actions panel — which matters it prints, how each bullet is
 * joined, and the lines that say what is not on it. Moved out of
 * `derivedCaptions.ts` unchanged to keep that file under the 300-line cap;
 * `derivedCaptions.ts` re-exports every exported name here.
 */

import { groupedCount } from '@/modules/accounting/services/packs/pages/packMatterWords';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { SelectedMatters } from '@/modules/accounting/services/packs/pages/packMattersPrinted';

/**
 * Spec §4.A page 4's narrow column: the action items the board is being asked
 * to decide, derived from the same matters model page 11 tabulates.
 *
 * WHY THE PANEL EXISTS AT ALL. Page 4 was being built as a commentary-only
 * page, so where no human had approved commentary it printed one italic line
 * — 1.0% fill on a sheet of its own, which spec §5.7 says does not ship. §4.A
 * specifies TWO columns, and the second one was simply never populated. With
 * it filled the page carries real content whether or not commentary is
 * approved, so the pack stays twelve pages either way (R-P57) instead of
 * changing shape according to an editorial state.
 *
 * ONE BULLET PER MATTER, drawn from the SELECTION page 11 prints — not from
 * the full matters list. The panel used to take its five from
 * `buildMatters`'s own ranking, so it named JE-2026-00002 as a top matter on
 * sheet 4 and sheet 11 did not list it anywhere: two pages, both claiming to
 * be "derived from the same checks", disagreeing about what the board's
 * action list is. Every bullet here is now a row a director can turn to.
 * What a board needs from this panel is WHICH matters are in front of it,
 * not a summary of them.
 *
 * THE DECISION IS STATED ONCE WHERE IT IS THE SAME FOR ALL OF THEM.
 * `buildMatters` gives every unusual journal the same `decisionRequired`, so
 * a bullet reading "<issue> — <decision>" per matter is the same sentence
 * five times, which is the repetition already undone in the matters table
 * itself. Where the decisions differ, each bullet carries its own.
 *
 * NO PAGE NUMBER IN THE OVERFLOW LINES. They name the matters page in words:
 * page numbers come from position now, and a literal here is the class of
 * cross-reference that sent a reader to the scorecard for the basis of
 * preparation.
 *
 * PROSE, NOT FIGURES. §4.A keeps page 4 free of tabular figures; a bulleted
 * list of decisions is prose, and nothing here formats a rand amount.
 */
const BOARD_ACTIONS_SHOWN = 5;

/**
 * And a LINE budget beside the count, for the same reason page 11 has one.
 *
 * Five is the right number of decisions to put in front of a board; it is not
 * a statement about how much paper five of them take. `buildMatters` embeds
 * `String(error)` in a failed-source matter, so a company whose debtor check
 * is timing out produces five bullets of two hundred characters each and page
 * 4 measured 318mm against a 255mm sheet — the twelve-sheet contract broken
 * from the commentary page rather than from the matters page. The overflow
 * line below already exists to carry whatever does not fit.
 *
 * Both numbers are measured off the printed sheet rather than derived: at
 * ~46 characters a line the panel came out 22.5mm past the paper, and the
 * fixture's own bullets put the column at about 27. The budget is what is
 * left of a 255mm box under the page header and beside the commentary
 * column. `packSheetCount.test.ts`'s long-null-quantum fixture is what holds
 * both honest.
 */
const BOARD_ACTION_CHARS_PER_LINE = 27;
const BOARD_ACTIONS_LINE_BUDGET = 30;

/** As many of the first `BOARD_ACTIONS_SHOWN` matters as the panel can print.
 *  At least one: a panel that lists nothing and says "5 further matters
 *  follow" is the silent omission the panel exists to prevent. */
function actionsThatFit(matters: PackMatter[]): PackMatter[] {
  const fits: PackMatter[] = [];
  let lines = 0;
  for (const matter of matters.slice(0, BOARD_ACTIONS_SHOWN)) {
    // The bullet is at most `issue — decisionRequired`; measured at its
    // longest so the budget holds whichever branch below is taken.
    const cost = Math.ceil(
      (matter.issue.length + matter.decisionRequired.length + 3) / BOARD_ACTION_CHARS_PER_LINE,
    );
    if (fits.length > 0 && lines + cost > BOARD_ACTIONS_LINE_BUDGET) break;
    fits.push(matter);
    lines += cost;
  }
  return fits;
}

/**
 * AN EM DASH JOINS A PHRASE TO A CLAUSE. IT DOES NOT FOLLOW A FULL STOP.
 *
 * Most matters state their issue as a noun phrase — "29 unreconciled bank
 * items across 3 bank accounts" — and `issue — decision` reads as one line.
 * The credit-month matter is three sentences of prose and ends in a full
 * stop, so the panel printed "…the month's revenue and other income of 39. —
 * Identify the reversals…", which is a punctuation mark that means nothing
 * after a sentence has already ended.
 *
 * The matters TABLE has the same two shapes in its Issue column and does not
 * hit this, because it puts the decision in its own column; only the panel
 * runs the two together.
 */
export function joinDecision(issue: string, decision: string): string {
  return /[.!?]$/.test(issue) ? `${issue} ${decision}` : `${issue} — ${decision}`;
}

/**
 * THE MATTERS THIS PAGE ACTUALLY PRINTS — one derivation, two readers.
 *
 * The panel below and page 4's TITLE both have to be about the same set. Page
 * 4 titled itself "Net profit of (1 544) for the period." — a value already
 * headlined on pages 3 and 6, on a sheet whose payload is a panel of board
 * decisions — and the tenth visual gate failed criteria 1, 9 and 15 on it.
 * Titling it by its payload means counting the payload, and a second count
 * derived from `selection.printed` would be the page-4-versus-page-11
 * disagreement `checkMattersCrossReference` exists to refuse, one page over.
 */
export function boardActionMatters(selection: SelectedMatters): PackMatter[] {
  // THE LARGEST EXPOSURE, THEN WHAT HAS NO AMOUNT, THEN THE REST. Page 11
  // lists the matters with no single amount first, because they have none to
  // fold into its "not printed" total; taken in that order, Velocity Fibre's
  // panel was the bank backlog and the bulk load, and its R10 353k debtor
  // concentration reached page 11 only. Ranked purely by money the other way,
  // three R6m journals pushed the reload of the whole ledger off the page.
  // So page 4 opens on the largest exposure, then the unquantified matters —
  // a backlog, a reload, an overdue filing, a failed check: the book's state
  // rather than one transaction — then the remaining exposures. Still a
  // subset of page 11, in page 11's ranking within each group.
  const quantified = selection.printed.filter((m) => m.quantum !== null);
  const unquantified = selection.printed.filter((m) => m.quantum === null);
  return actionsThatFit([...quantified.slice(0, 1), ...unquantified, ...quantified.slice(1)]);
}

export interface BoardActions {
  /** The matters themselves — one decision each. */
  items: string[];
  /**
   * WHAT IS NOT ON THE PANEL, which is not a matter and must not be set as
   * one.
   *
   * "1 further matter follows on the matters page." and "27 further matters
   * are not printed in this pack" are statements ABOUT the list; typeset as
   * list items they read as two more things for the board to decide, and a
   * director scanning a panel of decisions counts five.
   */
  tail: string[];
}

export function boardActionItems(selection: SelectedMatters): BoardActions {
  const { printed, omitted } = selection;
  if (printed.length === 0) return { items: [], tail: [] };

  const shown = boardActionMatters(selection);
  const decisions = new Set(shown.map((m) => m.decisionRequired));
  const uniform = shown.length > 1 && decisions.size === 1;

  const items = shown.map((matter) =>
    uniform ? matter.issue : joinDecision(matter.issue, matter.decisionRequired),
  );

  if (uniform) {
    items.push(`Each of these needs the same decision: ${shown[0]!.decisionRequired} (${shown[0]!.owner}).`);
  }

  // BOTH remainders, and both are read off the SAME selection page 11
  // prints from — never recomputed from the full list. The panel used to say
  // "23 further matters follow on the matters page" while that page listed
  // six and disclosed twenty-two that follow nowhere: two derivations of one
  // quantity, in the governance section, disagreeing two sheets apart.
  const alsoOnPage = printed.length - shown.length;
  const tail: string[] = [];
  if (alsoOnPage > 0) {
    tail.push(`${groupedCount(alsoOnPage)} further ${alsoOnPage === 1 ? 'matter follows' : 'matters follow'} on the matters page.`);
  }
  if (omitted.length > 0) {
    tail.push(`${groupedCount(omitted.length)} further ${omitted.length === 1 ? 'matter is' : 'matters are'} not printed in this pack; the matters page states what they come to.`);
  }
  return { items, tail };
}
