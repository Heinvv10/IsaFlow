/**
 * The CC1 (FNO) a supplier-bill line will carry, for display only (the line never picks it; the server derives
 * and posts it, see supplierDimensionDefaults.ts). Same rules, read from the cost centre ladder the master page
 * loads (`/api/accounting/cost-centres?detail=dimensions`): a CC2 takes the CC1 at the top of its parent chain, a
 * line that names only a CC1 (copied PO line) keeps it, and a line naming neither takes the supplier's default
 * CC1 when that one is still active.
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export interface LadderCentre { id: string; code: string; name: string; ccType: string; parentId: string | null; isActive: boolean }

const MAX_DEPTH = 16;
const label = (c: LadderCentre) => `${c.code} ${c.name}`;

export function deriveLineCc1(
  line: { cc1Id?: string; cc2Id?: string }, centres: readonly LadderCentre[], supplierCc1Id: string,
): string | null {
  const byId = new Map(centres.map((c) => [c.id, c]));
  if (line.cc2Id) {
    const seen = new Set<string>([line.cc2Id]);
    let cursor = byId.get(line.cc2Id)?.parentId ?? null;
    for (let depth = 0; cursor && depth < MAX_DEPTH && !seen.has(cursor); depth++) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (!node) return null;
      if (node.ccType === 'cc1') return label(node);
      cursor = node.parentId;
    }
    return null;
  }
  if (line.cc1Id) {
    const own = byId.get(line.cc1Id);
    return own ? label(own) : null;
  }
  const fallback = byId.get(supplierCc1Id);
  return fallback && fallback.isActive && fallback.ccType === 'cc1' ? label(fallback) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Pure: the ladder rows of a `detail=dimensions` response. */
export function ladderFromBody(body: unknown): LadderCentre[] {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  return items.filter(isRecord).map((r) => ({
    id: String(r.id ?? ''), code: String(r.code ?? ''), name: String(r.name ?? ''), ccType: String(r.ccType ?? ''),
    parentId: typeof r.parentId === 'string' ? r.parentId : null, isActive: r.isActive === true,
  }));
}

/** Loads the ladder once `enabled` (the Dimensions columns are open); empty until then or when the read fails. */
export function useCostCentreLadder(enabled: boolean): LadderCentre[] {
  const [centres, setCentres] = useState<LadderCentre[]>([]);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    apiJson('/api/accounting/cost-centres?detail=dimensions', undefined, 'Could not load the CC1 ladder')
      .then((body) => { if (live) setCentres(ladderFromBody(body)); })
      .catch((error: unknown) => { log.warn('CC1 ladder not loaded', { error }, 'supplier-invoices-new'); });
    return () => { live = false; };
  }, [enabled]);
  return centres;
}
