/**
 * "Explain this figure" (wave 5 M11): finds the explanation/drill button that belongs to the figure the person was on
 * before the palette opened. Buttons opt in with `data-explain-trigger` (payroll line explanations, VAT201 and EMP201
 * drills) and each figure's cell or row is a `data-explain-scope`, so this opens EX-core's and L3's own drawers and
 * computes nothing itself.
 *
 * The origin is the trigger itself, or something inside a scope holding exactly ONE trigger. Anything else (an unrelated
 * control, a scope with no trigger because the figure is zero, a scope with several) is null: guessing which figure was
 * meant would explain the wrong number. The walk never leaves the nearest scope.
 */
const TRIGGER = '[data-explain-trigger]';
const SCOPE = '[data-explain-scope]';

export function findExplainTrigger(origin: Element | null): HTMLElement | null {
  if (!origin) return null;
  if (origin.matches(TRIGGER)) return origin as HTMLElement;
  const scope = origin.closest(SCOPE);
  if (!scope) return null;
  const found = scope.querySelectorAll<HTMLElement>(TRIGGER);
  return found.length === 1 ? found[0] ?? null : null;
}

export const NOTHING_TO_EXPLAIN =
  'Nothing to explain here. Click a payroll line\'s PAYE, UIF, SDL or ETI figure, or a VAT201 or EMP201 total that has lines, then press Ctrl+K again.';
