/**
 * The 13-week page's data: the forecast, plus the stored inputs (overrides, expected items, pay day). Every load
 * takes a sequence number and only the latest one is applied, so a slow answer to an earlier load never
 * overwrites a newer one. A failed forecast load clears the forecast on screen rather than keep stale figures.
 *
 * The data layer's routes (PR #1509) may not be deployed: a 404 on GET overrides means "not here yet"
 * (`store: 'missing'`) and the page stays read-only; any other failure is `failed` with its message.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import type { CashForecast13 } from '@/modules/accounting/services/cashForecast13/types';
import {
  fetchForecast, fetchItems, fetchOverrides, fetchPayDay,
  type PayDaySetting, type StoredItem, type StoredOverride,
} from './cash13Client';

export type ForecastState = { status: 'loading' } | { status: 'ok'; data: CashForecast13 } | { status: 'error'; message: string };
export type StoreState = { status: 'loading' } | { status: 'ready' } | { status: 'missing' } | { status: 'failed'; message: string };
/** The expected items: a failed read is an error with the server's message, never an empty list. */
export type ItemsState = { status: 'loading' } | { status: 'ok'; data: StoredItem[] } | { status: 'error'; message: string };

export interface Cash13Data {
  forecast: ForecastState;
  store: StoreState;
  overrides: StoredOverride[];
  items: ItemsState;
  payDay: PayDaySetting | null;
  reload: () => Promise<void>;
  /** Runs a write; on success reloads everything. Returns the write's result. */
  write: (fn: () => Promise<ApiResult<unknown>>) => Promise<ApiResult<unknown>>;
}

function storeOf(r: ApiResult<unknown>): StoreState {
  if (r.ok) return { status: 'ready' };
  return r.kind === 'notFound' ? { status: 'missing' } : { status: 'failed', message: r.message };
}

export function useCash13(): Cash13Data {
  const [forecast, setForecast] = useState<ForecastState>({ status: 'loading' });
  const [store, setStore] = useState<StoreState>({ status: 'loading' });
  const [overrides, setOverrides] = useState<StoredOverride[]>([]);
  const [items, setItems] = useState<ItemsState>({ status: 'loading' });
  const [payDay, setPayDay] = useState<PayDaySetting | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const [f, o, i, p] = await Promise.all([fetchForecast(), fetchOverrides(), fetchItems(), fetchPayDay()]);
    if (mine !== seq.current) return; // a newer load started: this answer is stale
    setForecast(f.ok ? { status: 'ok', data: f.data } : { status: 'error', message: f.message });
    setStore(storeOf(o));
    setOverrides(o.ok ? o.data : []);
    setItems(i.ok ? { status: 'ok', data: i.data } : { status: 'error', message: i.message });
    setPayDay(p.ok ? p.data : null);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const write = useCallback(async (fn: () => Promise<ApiResult<unknown>>) => {
    const r = await fn();
    if (r.ok) await reload();
    return r;
  }, [reload]);

  return { forecast, store, overrides, items, payDay, reload, write };
}
