/**
 * Option groups for the kit Select: an option whose `group` differs from the option before it opens a heading.
 * The heading is a presentational row, not an option, so keyboard order and aria-activedescendant stay over the
 * flat option list. Groups are positional, never merged: the caller orders its options, and a group that comes back
 * after another (A, B, A) gets a second heading, in place. Search matches option labels only, not group names.
 */
import type { SelectOption } from './Select';

/** The heading to draw above option `index`: its group name when it opens a new run of that group, else null. */
export function groupHeadingAt(options: SelectOption[], index: number): string | null {
  const group = options[index]?.group;
  if (!group) return null;
  return options[index - 1]?.group === group ? null : group;
}

/** The DOM id of the heading above option `index` (by position, like the option's own id). */
export const groupHeadingId = (optionId: string): string => `${optionId}-group`;

export function SelectGroupHeading({ label, id }: { label: string; id: string }) {
  return (
    <li id={id} role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
      {label}
    </li>
  );
}
