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
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

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
  const [failed, setFailed] = useState(false);

  const fetchAdjacent = useCallback(async () => {
    if (!currentId) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await apiFetch(
        `/api/accounting/record-adjacent?entity=${entity}&id=${currentId}`
      );
      await assertOk(res, 'Could not load the neighbouring records');
      const json = await res.json() as { data?: AdjacentData } | AdjacentData;
      const data = (json as { data?: AdjacentData }).data ?? (json as AdjacentData);
      if (data && typeof data === 'object' && 'prevId' in data) {
        setAdjacent({ prevId: data.prevId, nextId: data.nextId });
      }
    } catch (err) {
      // Convenience control: no error banner, but never keep the previous record's neighbours
      // (they would navigate to the wrong record) and tell the user why the arrows are off.
      setAdjacent({ prevId: null, nextId: null });
      setFailed(true);
      log.warn('Record navigation could not load adjacent records', { error: err, entity }, 'record-navigation');
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
        title={failed ? 'Could not load the neighbouring records' : 'Previous record'}
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
        title={failed ? 'Could not load the neighbouring records' : 'Next record'}
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
