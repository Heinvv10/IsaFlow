/**
 * The integrity checks that hold the action panel and the matters page to one
 * list — their titles, their cross-reference and the exposure the matters
 * page states. Moved out of `packBlockIntegrity.ts` unchanged to keep that
 * file under the 300-line cap; `packBlockIntegrity.ts` re-exports both
 * exported checks, so existing import paths still resolve.
 */
import { EXPOSURE_CLAUSE } from '../pages/packMattersPage';
import { joinDecision } from '../narrative/derivedCaptions';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import type { PackPagesDocument } from '../pages/packPageModel';

/**
 * THE ACTION PANEL AND THE MATTERS TABLE ARE ONE LIST, AND THE DOCUMENT MUST
 * SAY SO.
 *
 * Page 4 told the board "23 further matters follow on the matters page" and
 * page 11 printed six, disclosing twenty-two that follow nowhere; page 4
 * named JE-2026-00002 as a top matter and page 11 did not list it at all.
 * Each page was internally correct. The cross-reference between them was
 * false, in the governance section, two sheets apart — which is the one
 * defect class a reader cannot check and a gate can.
 *
 * `selectPrintedMatters` now makes ONE selection that both pages read, so
 * this cannot drift by accident. It is asserted anyway, on the COMPOSED
 * document, because that is the artefact a director receives and because the
 * next author to give page 4 its own ranking would otherwise reintroduce it
 * silently.
 *
 * Structural, not a prose match: a bullet is matched against a printed
 * matter's `issue` exactly, or as `<issue> — <decision>`; the two derived
 * summary sentences are the ALLOW-LIST, and each carries the count it must
 * carry. The counts are required rather than merely checked when present —
 * a reworded sentence makes this red, not vacuous.
 *
 * AND THE AMOUNTS, WHICH IT NEVER COVERED. The rule this gate enforces was
 * written about COUNTING, so the two sentences on page 11 that state an
 * AMOUNT were outside it: the headline totalled every quantified matter and
 * the note under the table totalled the ones not printed, and the two used
 * different sign conventions to do it. On the live pack they happened to
 * decompose — 1 675 = 1 017 printed + 658 omitted — and one negative quantum
 * would have parted them with nothing to notice. `checkMattersAmounts` holds
 * the headline to the table beneath it: whatever the page says the exposure
 * is, it is the printed rows plus the omitted note, in the page's own words.
 */
/**
 * AND THE TWO TITLES COUNT THE SAME MATTERS. The list was one list and the
 * headlines over it were not: page 4 counted every row of the selection and
 * page 11 counted findings, so a clean pack — whose one row is the "every
 * check ran clean" line — was titled "1 of 1 matters requiring a board
 * decision" on one sheet and "0 matters require a board decision" on the
 * other. Each title states how many matters require a decision; the two
 * numbers are compared, and a title that states none is refused rather than
 * skipped.
 */
const RAISED_ON_PANEL_PAGE = /^(?:\d+ of (\d+) matters requiring a board decision|(0) matters require a board decision)/;
const RAISED_ON_MATTERS_PAGE = /^(\d+) matters? requires? a board decision/;

function checkMattersTitles(doc: PackPagesDocument): string[] {
  const panelPage = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'narrative' && b.boardActions !== undefined));
  const mattersPage = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'matters'));
  if (panelPage === undefined || mattersPage === undefined) return [];

  const onPanel = RAISED_ON_PANEL_PAGE.exec(panelPage.title);
  const onMatters = RAISED_ON_MATTERS_PAGE.exec(mattersPage.title);
  if (onPanel === null || onMatters === null) {
    const silent = onPanel === null ? panelPage : mattersPage;
    return [
      `Page ${silent.number} is titled "${silent.title}", which does not state how many matters `
        + 'require a board decision, so it cannot be held to the other page that counts them.',
    ];
  }
  const panelCount = Number(onPanel[1] ?? onPanel[2]);
  const mattersCount = Number(onMatters[1]);
  if (panelCount === mattersCount) return [];
  return [
    `Page ${panelPage.number} says ${panelCount} ${panelCount === 1 ? 'matter requires' : 'matters require'} `
      + `a board decision and page ${mattersPage.number} says ${mattersCount}. The two pages count the `
      + 'same matters differently, and a director cannot tell which is right.',
  ];
}

const FOLLOW_ON = /^(\d+) further matters? follows? on the matters page\./;
const NOT_PRINTED = /^(\d+) further matters? (?:is|are) not printed in this pack;/;
const SAME_DECISION = /^Each of these needs the same decision: /;

export function checkMattersCrossReference(doc: PackPagesDocument): string[] {
  const blocks = doc.pages.flatMap((page) => page.blocks);
  const table = blocks.find((b) => b.kind === 'matters');
  const panel = blocks.find((b) => b.kind === 'narrative' && b.boardActions !== undefined);
  if (table === undefined || table.kind !== 'matters') return [];
  if (panel === undefined || panel.kind !== 'narrative' || panel.boardActions === undefined) return [];

  const printed = table.matters;
  const omittedCount = table.omitted?.count ?? 0;
  const failures: string[] = [...checkMattersTitles(doc)];

  let named = 0;
  let followOn: number | null = null;
  let notPrinted: number | null = null;
  // THE COUNTS MOVED OUT OF THE LIST AND THE CHECK FOLLOWED THEM. They are
  // set below the panel now, smaller — a statement ABOUT the list is not a
  // member of it — and reading `boardActions` alone made this refuse every
  // pack that discloses an omission. Both halves are the panel.
  for (const item of [...panel.boardActions, ...(panel.boardActionsTail ?? [])]) {
    const follow = FOLLOW_ON.exec(item);
    if (follow !== null) { followOn = Number(follow[1]); continue; }
    const rest = NOT_PRINTED.exec(item);
    if (rest !== null) { notPrinted = Number(rest[1]); continue; }
    if (SAME_DECISION.test(item)) continue;

    named += 1;
    // THE PANEL'S OWN JOINER, not a second spelling of it. This matched
    // `${issue} — ` literally, and the panel stopped using an em dash after an
    // issue that ends in a full stop (see `joinDecision`) — so the one matter
    // whose issue is prose rather than a noun phrase read as a matter the
    // table does not list, and the render was refused. Matched exactly rather
    // than by prefix, which is also stricter than what it replaces.
    const onTable = printed.some((m) => item === m.issue
      || item === joinDecision(m.issue, m.decisionRequired));
    if (!onTable) {
      failures.push(
        `The action panel names a matter the matters page does not list: "${item}". `
          + `Both pages are derived from the same checks and a director cannot look this one up.`,
      );
    }
  }

  const expectedFollowOn = printed.length - named;
  if (expectedFollowOn > 0 && followOn !== expectedFollowOn) {
    failures.push(
      `The action panel says ${followOn ?? 'nothing'} about how many further matters follow on the `
        + `matters page; that page lists ${printed.length} and the panel names ${named}, so ${expectedFollowOn} follow.`,
    );
  }
  if (omittedCount > 0 && notPrinted !== omittedCount) {
    failures.push(
      `The action panel says ${notPrinted ?? 'nothing'} about matters not printed in this pack; `
        + `the matters page discloses ${omittedCount}.`,
    );
  }
  return failures;
}

/**
 * The page's headline exposure, re-derived from the table under it.
 *
 * The title is a SENTENCE, so the check is that the sentence contains the
 * amount — formatted at the document's own scale, because a figure built at
 * another scale would never match the page's text and the gate would refuse a
 * pack that says exactly what it must (the same reasoning as the plug
 * disclosure above).
 */
export function checkMattersAmounts(doc: PackPagesDocument, scale: MoneyScale): string[] {
  const page = doc.pages.find((p) => p.blocks.some((b) => b.kind === 'matters'));
  const table = page?.blocks.find((b) => b.kind === 'matters');
  if (page === undefined || table === undefined || table.kind !== 'matters') return [];

  // Only where the page STATES an exposure. A pack whose matters carry no rand
  // amount says so in words, and a gate that invented a zero to compare
  // against would refuse it for printing the truth.
  if (!page.title.includes(EXPOSURE_CLAUSE)) return [];

  const printed = table.matters
    .map((m) => m.quantum.value)
    .filter((v): v is number => v !== null);
  const omitted = table.omitted?.quantum.value ?? 0;
  const total = printed.reduce((sum, v) => sum + Math.abs(v), 0) + Math.abs(omitted);
  const stated = formatMoney(total, { scale });
  if (page.title.includes(stated)) return [];
  return [
    `Page ${page.number} says "${page.title}" over a table whose printed rows and omitted note `
      + `come to ${stated} ${scale}. A sentence that totals something states the total of the `
      + 'matters it describes, never a second derivation of it.',
  ];
}
