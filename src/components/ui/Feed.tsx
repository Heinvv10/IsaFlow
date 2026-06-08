/**
 * Feed — a titled list surface for a stream of rows (typically ActionRow).
 * Theme-aware via Card; renders an empty state when it has no children.
 *
 * Usage:
 *   <Feed title="Work owed today" empty="All caught up.">
 *     {items.map((i) => <ActionRow key={i.id} ... />)}
 *   </Feed>
 */
import * as React from 'react';
import { Card } from './Card';

export interface FeedProps {
  title: React.ReactNode;
  /** Optional control rendered on the right of the header (e.g. a link). */
  action?: React.ReactNode;
  /** Rendered centered when there are no children. */
  empty?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function Feed({ title, action, empty, children, className }: FeedProps) {
  const isEmpty = React.Children.count(children) === 0;
  return (
    <Card noPadding className={className}>
      <div className="flex items-center justify-between gap-4 border-b border-[var(--ff-border-primary)] px-4 py-3">
        <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</h2>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {isEmpty ? (
        <div className="px-4 py-12 text-center text-sm text-[var(--ff-text-tertiary)]">{empty}</div>
      ) : (
        <div className="divide-y divide-[var(--ff-border-primary)]">{children}</div>
      )}
    </Card>
  );
}

Feed.displayName = 'Feed';
