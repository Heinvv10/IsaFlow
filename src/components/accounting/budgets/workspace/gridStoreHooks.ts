/**
 * React reads of the grid store (`useSyncExternalStore`). A row component calls `useGridRow` for
 * its own key only, so an edit re-renders that row (and the subtotal rows through
 * `useGridTotal`), never the grid.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { GridStore } from './gridStore';
import type { GridLayout, GridMeta, GridRowSnapshot, GridTotalSnapshot } from './types';

export function useGridLayout(store: GridStore): GridLayout {
  return useSyncExternalStore(store.subscribeLayout, store.getLayout, store.getLayout);
}

export function useGridRow(store: GridStore, rowKey: string): GridRowSnapshot {
  const subscribe = useCallback((cb: () => void) => store.subscribeRow(rowKey, cb), [store, rowKey]);
  const get = useCallback(() => store.getRow(rowKey), [store, rowKey]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useGridTotal(store: GridStore, metric: Metric): GridTotalSnapshot {
  const subscribe = useCallback((cb: () => void) => store.subscribeTotal(metric, cb), [store, metric]);
  const get = useCallback(() => store.getTotal(metric), [store, metric]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useGridMeta(store: GridStore): GridMeta {
  return useSyncExternalStore(store.subscribeMeta, store.getMeta, store.getMeta);
}
