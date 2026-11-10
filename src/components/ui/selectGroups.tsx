/**
 * Option groups for the kit Select: an option with the same `group` as the one before it sits under that group's
 * heading. The heading is a presentational row, not an option, so keyboard order and aria-activedescendant stay
 * over the flat option list. Options of one group must be adjacent (the caller orders them).
 */
import type { SelectOption } from './Select';

/** The heading to draw above option `index`: its group name when it opens a new group, else null. */
export function groupHeadingAt(options: SelectOption[], index: number): string | null {
  const group = options[index]?.group;
  if (!group) return null;
  return options[index - 1]?.group === group ? null : group;
}

export function SelectGroupHeading({ label }: { label: string }) {
  return (
    <li role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
      {label}
    </li>
  );
}
