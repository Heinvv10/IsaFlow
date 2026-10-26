/**
 * ListEmpty: the empty result of a list page. A true first run (no rows, no
 * active filter) gets the signature empty state with its first action and
 * "Try the demo company"; a filtered-empty result only says so and offers to
 * clear the filters, because nothing is wrong with the company's books.
 */
import type { ComponentProps } from 'react';
import { SearchX } from 'lucide-react';
import { EmptyState } from './EmptyState';

type FirstRunProps = Pick<
  ComponentProps<typeof EmptyState>,
  'icon' | 'title' | 'description' | 'primaryAction' | 'secondaryAction' | 'checklist'
>;

interface ListEmptyProps {
  /** Any search, tab or filter narrowing the list is active. */
  filtered: boolean;
  onClearFilters?: () => void;
  firstRun: FirstRunProps;
}

export function ListEmpty({ filtered, onClearFilters, firstRun }: ListEmptyProps) {
  if (filtered) {
    return (
      <EmptyState
        icon={SearchX}
        title="No results"
        description="Nothing matches the current search or filters."
        primaryAction={onClearFilters ? { label: 'Clear filters', onClick: onClearFilters } : undefined}
      />
    );
  }
  return <EmptyState {...firstRun} demo />;
}
