/**
 * RecordNavigation
 * Prev/Next arrow buttons that let users page through records in name order,
 * matching the Sage Accounting UX pattern.
 *
 * Usage:
 *   <RecordNavigation entity="customers" currentId={customerId} basePath="/accounting/customers" />
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

export type RecordEntity = 'customers' | 'suppliers' | 'items';

interface Props {
  entity: RecordEntity;
  currentId: string;
  basePath: string;
}

interface AdjacentData {
  prevId: string | null;
  nextId: string | null;
}

export function RecordNavigation({ entity, currentId, basePath }: Props) {
  const router = useRouter();
  const [adjacent, setAdjacent] = useState<AdjacentData>({ prevId: null, nextId: null });
  const [loading, setLoading] = useState(false);

  const fetchAdjacent = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/accounting/record-adjacent?entity=${entity}&id=${currentId}`
      );
      if (!res.ok) return;
      const json = await res.json() as { data?: AdjacentData } | AdjacentData;
      const data = (json as { data?: AdjacentData }).data ?? (json as AdjacentData);
      if (data && typeof data === 'object' && 'prevId' in data) {
        setAdjacent({ prevId: data.prevId, nextId: data.nextId });
      }
    } catch {
      // Navigation is non-critical — silently ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [entity, currentId]);

  useEffect(() => {
    void fetchAdjacent();
  }, [fetchAdjacent]);

  const navigate = (id: string | null) => {
    if (!id) return;
    void router.push(`${basePath}/${id}`);
  };

  return (
    <div className="inline-flex items-center gap-1" aria-label="Record navigation">
      <button
        onClick={() => navigate(adjacent.prevId)}
        disabled={loading || !adjacent.prevId}
        title="Previous record"
        aria-label="Previous record"
        className={`
          inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium
          border border-[var(--ff-border-light)] transition-colors
          ${adjacent.prevId && !loading
            ? 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-border-medium)] hover:bg-[var(--ff-bg-primary)] cursor-pointer'
            : 'text-[var(--ff-text-tertiary)] opacity-40 cursor-not-allowed'
          }
        `}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Prev
      </button>

      <button
        onClick={() => navigate(adjacent.nextId)}
        disabled={loading || !adjacent.nextId}
        title="Next record"
        aria-label="Next record"
        className={`
          inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium
          border border-[var(--ff-border-light)] transition-colors
          ${adjacent.nextId && !loading
            ? 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-border-medium)] hover:bg-[var(--ff-bg-primary)] cursor-pointer'
            : 'text-[var(--ff-text-tertiary)] opacity-40 cursor-not-allowed'
          }
        `}
      >
        Next
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
