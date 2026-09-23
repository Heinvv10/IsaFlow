/**
 * Restores an aging view to where an invoice drill-down left it: re-expands
 * the `?customer=` / `?supplier=` row, scrolls it into view, and hands back a
 * `?as_at_date=`. The counterpart of buildInvoiceHref in invoiceReturnContext.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { ISO_DATE } from './invoiceReturnContext';

export function agingRowId(entityId: string): string {
  return `aging-row-${entityId}`;
}

interface Options {
  entityParam: 'customer' | 'supplier';
  /** True once the rows are on screen, so the restored row can be scrolled to. */
  rowsReady: boolean;
  /** Receives a valid `?as_at_date=` in the same update that sets `restored`. */
  onAsAtDate?: (date: string) => void;
}

export function useAgingReturn({ entityParam, rowsReady, onAsAtDate }: Options) {
  const router = useRouter();
  const [restored, setRestored] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pendingScroll = useRef<string | null>(null);

  useEffect(() => {
    if (!router.isReady || restored) return;
    const entity = router.query[entityParam];
    const asAt = router.query.as_at_date;
    if (typeof entity === 'string' && entity) {
      setExpandedId(entity);
      pendingScroll.current = entity;
    }
    if (onAsAtDate && typeof asAt === 'string' && ISO_DATE.test(asAt)) onAsAtDate(asAt);
    setRestored(true);
  }, [router.isReady, router.query, entityParam, onAsAtDate, restored]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (!rowsReady || !id) return;
    pendingScroll.current = null;
    document.getElementById(agingRowId(id))?.scrollIntoView({ block: 'center' });
  }, [rowsReady, expandedId]);

  const toggle = useCallback((id: string) => setExpandedId(cur => (cur === id ? null : id)), []);

  return { restored, expandedId, toggle };
}
