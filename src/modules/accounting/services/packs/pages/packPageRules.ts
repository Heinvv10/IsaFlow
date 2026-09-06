/**
 * The board pack's two page-level RULES, split out of `packPageModel.ts`.
 *
 * The model file is types; these are the functions over them, and it sat at
 * exactly the 300-line cap — so the `matters` block kind R-P49 requires had
 * nowhere to go. Moving the rules rather than trimming a doc comment follows
 * the same grain the `packPageBlocks.ts` split used: nothing here changed,
 * it only moved, and `packPageModel.ts` re-exports both names so every
 * existing import path still resolves.
 */


/**
 * Page titles that are navigation, not a conclusion about the period, and so
 * are exempt from the message rule by exact match. Page 1's title (the
 * company's legal name) is exempt separately, by page NUMBER — see below.
 */
const EXEMPT_NAVIGATION_TITLES = new Set([
  'Contents',
  'Basis of preparation and definitions',
  'Matters requiring board attention',
]);

/** A verb of movement — the heuristic's other admission besides a digit. */
const MOVEMENT_VERBS = [
  'up', 'down', 'widened', 'narrowed', 'met', 'missed', 'improved', 'fell', 'rose', 'held',
];

/**
 * Reject a bare label in place of a title that states a conclusion.
 *
 * This is a heuristic, deliberately: it allows a title through when it
 * contains a digit or one of a small set of movement verbs, and rejects it
 * otherwise. Its job is to fail the exact class of title the rejected pack
 * shipped ('Financial Ratios', 'Commentary', 'KPI Scorecard') — it cannot
 * judge whether an admitted title is actually a good conclusion. That
 * judgement is the visual gate's, applied to the rendered page, not this
 * function's.
 */
export function assertPageTitleIsAMessage(title: string, pageNumber: number): void {
  // Page 1's title is the company's legal name — arbitrary data we do not
  // choose, exempt by page number rather than by matching its text.
  if (pageNumber === 1) return;
  if (EXEMPT_NAVIGATION_TITLES.has(title)) return;

  const hasDigit = /\d/.test(title);
  const lower = title.toLowerCase();
  const hasMovementVerb = MOVEMENT_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(lower));

  if (!hasDigit && !hasMovementVerb) {
    throw new Error(
      `Page ${pageNumber} title '${title}' is a bare label, not a conclusion ` +
        `about the period. A title must contain a digit or one of: ` +
        `${MOVEMENT_VERBS.join(', ')}. This is a cheap guard in front of the ` +
        `real judge, which is the visual gate applied to the rendered page.`,
    );
  }
}

/**
 * Whether a page number falls under the "content page" density rule.
 *
 * The cover (1) and contents (2) are excluded — neither carries the tables
 * and scorecards the density rule governs.
 */
export function isContentPage(pageNumber: number): boolean {
  return pageNumber > 2;
}
