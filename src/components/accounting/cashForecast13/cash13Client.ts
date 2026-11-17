/**
 * The 13-week cash page's fetchers. `apiFetch` RESOLVES on a 4xx, so every call goes through the budget
 * workspace's `call` and returns an `ApiResult` (data, or a typed failure with the server's message); nothing
 * throws on a status or a dropped connection. apiFetch adds the CSRF header to the writes.
 *
 * Every route is registered in apiRoutesBudgets; the wire types are the services' (`import type` only, so no
 * server code reaches the bundle). A 2xx whose body is not the expected shape is still refused (`shaped`).
 */
import { call } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import type { CashForecast13 } from '@/modules/accounting/services/cashForecast13/types';
import type { StoredOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import type { StoredCashItem } from '@/modules/accounting/services/cashForecast13/itemsRepo';
import type { PayDaySetting } from '@/modules/accounting/services/cashForecast13/payDaySetting';
import type { ItemInput } from '@/modules/accounting/services/cashForecast13/storeSchemas';
import type { ManualItemDirection, ManualItemRepeat, PayDayRule } from '@/modules/accounting/services/cashForecast13/storeTypes';
import type { OverrideBody } from './overridePayload';

const BASE = '/api/accounting/cash-forecast-13';

export type { StoredOverride, StoredCashItem as StoredItem, PayDaySetting, PayDayRule };
export type ItemDirection = ManualItemDirection;
export type ItemRepeat = ManualItemRepeat;
/** The POST /items body (storeSchemas.ItemInput's input, less the optional account the page does not set). */
export type ItemBody = Omit<ItemInput, 'accountId'>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A 2xx whose body is not the expected shape is a failure, never a half-drawn page. */
function shaped<T>(r: ApiResult<unknown>, is: (d: unknown) => d is T, fallback: string): ApiResult<T> {
  if (!r.ok) return r;
  return is(r.data) ? { ok: true, data: r.data } : { ok: false, kind: 'failed', message: fallback, status: 200 };
}

const isForecast = (d: unknown): d is CashForecast13 => isObj(d) && Array.isArray(d.weeks) && Array.isArray(d.lines) && isObj(d.overdueAR) && Array.isArray(d.warnings);

export async function fetchForecast(): Promise<ApiResult<CashForecast13>> {
  const fallback = 'Could not load the 13-week forecast - try again.';
  return shaped(await call('/api/accounting/cash-forecast-13', undefined, fallback), isForecast, fallback);
}

export async function fetchOverrides(): Promise<ApiResult<StoredOverride[]>> {
  const fallback = 'Could not load your changes to the forecast.';
  const r = shaped(await call('/api/accounting/cash-forecast-13/overrides', undefined, fallback), (d): d is { overrides: StoredOverride[] } => isObj(d) && Array.isArray(d.overrides), fallback);
  return r.ok ? { ok: true, data: r.data.overrides } : r;
}

export async function fetchItems(): Promise<ApiResult<StoredCashItem[]>> {
  const fallback = 'Could not load your expected items.';
  const r = shaped(await call('/api/accounting/cash-forecast-13/items', undefined, fallback), (d): d is { items: StoredCashItem[] } => isObj(d) && Array.isArray(d.items), fallback);
  return r.ok ? { ok: true, data: r.data.items } : r;
}

export async function fetchPayDay(): Promise<ApiResult<PayDaySetting>> {
  const fallback = 'Could not load the pay day.';
  return shaped(await call('/api/accounting/cash-forecast-13/pay-day', undefined, fallback), (d): d is PayDaySetting => isObj(d) && isObj(d.payDay), fallback);
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export async function saveOverride(body: OverrideBody): Promise<ApiResult<unknown>> {
  return call(`${BASE}/overrides`, json('PUT', body), 'Could not save the change - try again.');
}

export async function deleteOverride(id: string): Promise<ApiResult<unknown>> {
  return call(`${BASE}/overrides?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not remove the change - try again.');
}

export async function createItem(body: ItemBody): Promise<ApiResult<unknown>> {
  return call(`${BASE}/items`, json('POST', body), 'Could not add the item - try again.');
}

export async function deleteItem(id: string): Promise<ApiResult<unknown>> {
  return call(`${BASE}/items?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not remove the item - try again.');
}

export async function savePayDay(rule: PayDayRule): Promise<ApiResult<unknown>> {
  return call(`${BASE}/pay-day`, json('PUT', rule), 'Could not save the pay day - try again.');
}
