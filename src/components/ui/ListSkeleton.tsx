/**
 * ListSkeleton: the loading state of a list or table page. Drawn at roughly
 * the height of a first page so the content does not jump when rows arrive.
 */
import { Skeleton } from './Skeleton';

interface ListSkeletonProps {
  rows?: number;
  /** Accessible name; the page is busy, not empty. */
  label?: string;
  /** Row box classes, to match the real row height (default is a compact row). */
  rowClassName?: string;
}

export function ListSkeleton({ rows = 8, label = 'Loading', rowClassName = 'py-1' }: ListSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-testid="list-skeleton"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
    >
      <Skeleton.Group className="gap-4">
        <Skeleton variant="heading" width="30%" />
        <Skeleton variant="table-row" count={rows} className={rowClassName} />
      </Skeleton.Group>
    </div>
  );
}
