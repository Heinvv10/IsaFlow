/**
 * "Explain this figure" (wave 5 M11): finds the explanation/drill button that belongs to the figure the person was on
 * before the palette opened. Buttons opt in with `data-explain-trigger` (payroll line explanations, VAT201 and EMP201
 * drills), so this opens EX-core's and L3's own drawers and computes nothing itself.
 *
 * From the focused element it looks at the element itself, then each ancestor in turn (up to a page section): the first
 * ancestor holding exactly ONE trigger wins. Two or more means the focus is on something that spans several figures,
 * and guessing which one was meant would explain the wrong number, so it returns null.
 */
const TRIGGER = '[data-explain-trigger]';
const MAX_LEVELS = 6;

export function findExplainTrigger(origin: Element | null): HTMLElement | null {
  let node: Element | null = origin;
  for (let level = 0; node && level <= MAX_LEVELS; level += 1, node = node.parentElement) {
    if (node.matches(TRIGGER)) return node as HTMLElement;
    // The whole page is not "the figure you were on".
    if (node === document.body || node === document.documentElement) return null;
    const found = node.querySelectorAll<HTMLElement>(TRIGGER);
    if (found.length === 1) return found[0] ?? null;
    if (found.length > 1) return null;
  }
  return null;
}

export const NOTHING_TO_EXPLAIN =
  'Nothing to explain here. Click into a payroll line\'s PAYE, UIF, SDL or ETI figure, or a VAT201 or EMP201 total, then press Ctrl+K again.';
