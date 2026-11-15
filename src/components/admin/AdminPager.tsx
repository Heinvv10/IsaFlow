/**
 * The admin lists' footer: "Page N of M" and previous/next chevrons. Shared by Companies, Users and Subscriptions,
 * which each had the same markup inline.
 */
import type { Dispatch, SetStateAction } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const BUTTON = 'p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

export function AdminPager({ page, totalPages, setPage }: { page: number; totalPages: number; setPage: Dispatch<SetStateAction<number>> }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
      <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className={BUTTON}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className={BUTTON}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
