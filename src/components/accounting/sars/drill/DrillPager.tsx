/** Previous / range / Next under a paged drill. Both buttons are off while a page loads; Next is off after a failed load (Retry is the way forward). */
import { Button } from '@/components/ui/Button';

interface Props {
  page: number; pageSize: number; rowCount: number | null; hasMore: boolean | null;
  loading: boolean; failed: boolean; onPage: (page: number) => void;
}

export function DrillPager({ page, pageSize, rowCount, hasMore, loading, failed, onPage }: Props) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Button variant="secondary" size="sm" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="text-center text-xs text-[var(--ff-text-secondary)]" data-testid="return-drill-range">
        {rowCount === null ? `Page ${page}` : `Showing ${rowCount === 0 ? 0 : (page - 1) * pageSize + 1}–${Math.min(page * pageSize, rowCount)} of ${rowCount}`}
      </span>
      <Button variant="secondary" size="sm" disabled={loading || failed || (hasMore !== null && !hasMore)} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}
