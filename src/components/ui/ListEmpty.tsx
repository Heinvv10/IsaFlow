/**
 * ListEmpty: the empty result of a list page. A true first run (no rows, no
 * active filter, first page) gets the signature empty state with its first
 * action and "Try the demo company"; a filtered-empty result only says so and
 * offers to clear the filters; a page past the last result offers the first
 * page. Neither of those is a first run, so neither offers the demo.
 */
import type { ComponentProps } from 'react';
import { SearchX } from 'lucide-react';
import { TryDemoLink } from '@/components/onboarding/TryDemoLink';
import { EmptyState } from './EmptyState';

type FirstRunProps = Pick<
  ComponentProps<typeof EmptyState>,
  'icon' | 'title' | 'description' | 'primaryAction' | 'secondaryAction' | 'checklist'
>;

interface ListEmptyProps {
  /** Any search, tab or filter narrowing the list is active. */
  filtered: boolean;
  onClearFilters?: () => void;
  /** Paged lists: the page asked for and the total the server counted. */
  page?: number;
  total?: number;
  onFirstPage?: () => void;
  firstRun: FirstRunProps;
}

export function ListEmpty({ filtered, onClearFilters, page = 1, total = 0, onFirstPage, firstRun }: ListEmptyProps) {
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
  if (page > 1 || total > 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="Nothing on this page"
        description="This page is past the last result."
        primaryAction={onFirstPage ? { label: 'Go to the first page', onClick: onFirstPage } : undefined}
      />
    );
  }
  return <EmptyState {...firstRun} footer={<TryDemoLink />} />;
}
