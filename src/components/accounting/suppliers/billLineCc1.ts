/**
 * The CC1 (FNO) a supplier-bill line will carry, for display only (the line never picks it; the server derives
 * and posts it). It follows the server's order, never a second implementation of the derivation:
 *  1. a line naming neither a CC1 nor a CC2 takes the supplier's default CC1 and CC2 (applySupplierDefaultDimensions;
 *     the defaults handed in are the active ones, the server skips an inactive one);
 *  2. a CC2 whose chain reaches an FNO takes that FNO, which the server returns per row as `fnoCode`
 *     (`/api/accounting/cost-centres?detail=dimensions`); a different CC1 on the line is refused on save;
 *  3. otherwise the line's own (or defaulted) CC1 stays.
 * An inactive CC1 is refused on save too, so it is shown marked rather than as fine.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export interface LadderCentre { id: string; code: string; name: string; ccType: string; isActive: boolean; fnoCode: string | null }

export interface LadderIndex { byId: ReadonlyMap<string, LadderCentre>; fnoByCode: ReadonlyMap<string, LadderCentre> }

export interface Cc1Display { label: string; /** '' when the CC1 can be saved, else why it cannot. */ note: string }

export interface SupplierCcDefaults { cc1Id?: string; cc2Id?: string }

const EMPTY_INDEX: LadderIndex = { byId: new Map(), fnoByCode: new Map() };

export function indexLadder(centres: readonly LadderCentre[]): LadderIndex {
  return {
    byId: new Map(centres.map((c) => [c.id, c])),
    fnoByCode: new Map(centres.filter((c) => c.ccType === 'cc1' && c.fnoCode === c.code).map((c) => [c.code, c])),
  };
}

const label = (c: LadderCentre) => `${c.code} ${c.name}`;
const show = (c: LadderCentre): Cc1Display => ({ label: label(c), note: c.isActive ? '' : 'inactive, cannot be saved' });

export function deriveLineCc1(
  line: { cc1Id?: string; cc2Id?: string }, ladder: LadderIndex, supplier: SupplierCcDefaults,
): Cc1Display | null {
  const namesCc = Boolean(line.cc1Id || line.cc2Id);
  const defaultCc1 = supplier.cc1Id ? ladder.byId.get(supplier.cc1Id) : undefined;
  const ownCc1 = line.cc1Id || (!namesCc && defaultCc1?.isActive ? defaultCc1.id : '');
  const cc2 = line.cc2Id || (!namesCc ? supplier.cc2Id ?? '' : '');
  const fnoCode = cc2 ? ladder.byId.get(cc2)?.fnoCode ?? null : null;
  const fno = fnoCode ? ladder.fnoByCode.get(fnoCode) : undefined;
  const own = ownCc1 ? ladder.byId.get(ownCc1) : undefined;
  if (fno) {
    if (own && own.id !== fno.id) return { label: label(own), note: `conflicts with the project's FNO ${label(fno)}, cannot be saved` };
    return show(fno);
  }
  return own ? show(own) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Pure: the master rows of a `detail=dimensions` response. */
export function ladderFromBody(body: unknown): LadderCentre[] {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  return items.filter(isRecord).map((r) => ({
    id: String(r.id ?? ''), code: String(r.code ?? ''), name: String(r.name ?? ''), ccType: String(r.ccType ?? ''),
    isActive: r.isActive === true, fnoCode: typeof r.fnoCode === 'string' ? r.fnoCode : null,
  }));
}

export interface CostCentreLadder { status: 'idle' | 'loading' | 'ready' | 'failed'; index: LadderIndex }

/**
 * Loads the ladder when `enabled` (the Dimensions columns are open) and keeps it: toggling Dimensions off and on
 * does not read it again. A failed read is logged and tried again on `retry`, or the next time it is enabled; it
 * never blocks the form.
 */
export function useCostCentreLadder(enabled: boolean): CostCentreLadder & { retry: () => void } {
  const [state, setState] = useState<CostCentreLadder>({ status: 'idle', index: EMPTY_INDEX });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const requested = useRef(false);
  useEffect(() => {
    if (!enabled || requested.current) return undefined;
    requested.current = true;
    setState((s) => ({ ...s, status: 'loading' }));
    apiJson('/api/accounting/cost-centres?detail=dimensions', undefined, 'Could not load the CC1 ladder')
      .then((body) => setState({ status: 'ready', index: indexLadder(ladderFromBody(body)) }))
      .catch((error: unknown) => {
        requested.current = false;
        log.warn('CC1 ladder not loaded', { error }, 'supplier-invoices-new');
        setState((s) => ({ ...s, status: 'failed' }));
      });
    return undefined;
  }, [enabled, attempt]);
  return { ...state, retry };
}
