/**
 * usePageClamp: keep the bank transactions page inside the list. Accepting, excluding or undoing the
 * last row of the last page reloads a page that is now past the end: no rows, and a total above zero.
 * Once that load settles, move to the last page that exists; the page change is what refetches, so it
 * happens once.
 */
import { useEffect } from 'react';

export function lastPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** The page lies beyond the last page `total` allows: the rows are gone and usePageClamp is about to move. */
export function bankTxPastEnd(page: number, total: number, pageSize: number): boolean {
  return page > lastPage(total, pageSize);
}

interface Args {
  page: number;
  total: number;
  pageSize: number;
  /** The total belongs to the last finished load; judge it only once that load has settled. */
  isLoading: boolean;
  setPage: (page: number) => void;
}

export function usePageClamp({ page, total, pageSize, isLoading, setPage }: Args): void {
  useEffect(() => {
    if (isLoading) return;
    const last = lastPage(total, pageSize);
    if (page > last) setPage(last);
  }, [page, total, pageSize, isLoading, setPage]);
}
