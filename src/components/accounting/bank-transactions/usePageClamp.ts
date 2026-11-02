/**
 * usePageClamp: keep the bank transactions page inside the list. Accepting, excluding or undoing the
 * last row of the last page reloads a page that is now past the end: no rows, and a total above zero.
 * Once that load settles, move to the last page that exists; the page change is what refetches, so it
 * happens once. A load that failed says nothing about the total (the page zeroes it), so a failure never clamps:
 * the error shows on the page the user asked for.
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
  /** The last load failed: its empty rows and zero total are not evidence that the page is past the end. */
  failed?: boolean;
  setPage: (page: number) => void;
}

export function usePageClamp({ page, total, pageSize, isLoading, failed = false, setPage }: Args): void {
  useEffect(() => {
    if (isLoading || failed) return;
    const last = lastPage(total, pageSize);
    if (page > last) setPage(last);
  }, [page, total, pageSize, isLoading, failed, setPage]);
}
