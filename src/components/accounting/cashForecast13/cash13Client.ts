/**
 * The 13-week cash page's fetchers. `apiFetch` RESOLVES on a 4xx, so every call goes through the budget
 * workspace's `call` and returns an `ApiResult` (data, or a typed failure with the server's message); nothing
 * throws on a status or a dropped connection. apiFetch adds the CSRF header to the writes.
 *
 * The forecast GET is the engine's route (registered: its type comes from the service). The stored inputs
 * (items, overrides, pay day) are the data layer's routes (PR #1509): until that merges their service types are
 * not on master, so their wire shapes are written out below from #1509's storeTypes / overridesRepo / itemsRepo /
 * payDaySetting. Switch them to `import type` from those modules (and register the routes) once #1509 merges.
 */
import { call } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import type { CashCategory, CashForecast13 } from '@/modules/accounting/services/cashForecast13/types';
import type { OverrideBody, OverrideMode } from './overridePayload';

const BASE = '/api/accounting/cash-forecast-13';

/** #1509 overridesRepo.StoredOverride. */
export interface StoredOverride {
  id: string;
  lineKey: string;
  weekStart: string;
  mode: OverrideMode;
  amount: number | null;
  targetWeekStart?: string;
  note: string | null;
}

export type ItemDirection = 'receipt' | 'payment';
export type ItemRepeat = 'none' | 'weekly' | 'monthly';

/** #1509 itemsRepo.StoredCashItem (less the account and stamp the page does not use). */
export interface StoredItem {
  id: string;
  direction: ItemDirection;
  amount: number;
  date: string;
  repeat: ItemRepeat;
  repeatUntil: string | null;
  description: string;
  category: CashCategory;
}

/** #1509 storeSchemas.ItemInput. */
export interface ItemBody {
  direction: ItemDirection;
  amount: number;
  date: string;
  repeat: ItemRepeat;
  repeatUntil: string | null;
  description: string;
  category: CashCategory;
}

/** #1509 storeTypes.PayDayRule / payDaySetting.PaySetting. */
export type PayDayRule = { kind: 'day_of_month'; day: number } | { kind: 'last_working_day' };
export interface PayDaySetting { payDay: PayDayRule; day: number; isDefault: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A 2xx whose body is not the expected shape is a failure, never a half-drawn page. */
function shaped<T>(r: ApiResult<unknown>, is: (d: unknown) => d is T, fallback: string): ApiResult<T> {
  if (!r.ok) return r;
  return is(r.data) ? { ok: true, data: r.data } : { ok: false, kind: 'failed', message: fallback, status: 200 };
}

const isForecast = (d: unknown): d is CashForecast13 => isObj(d) && Array.isArray(d.weeks) && Array.isArray(d.lines) && isObj(d.overdueAR) && Array.isArray(d.warnings);

export async function fetchForecast(): Promise<ApiResult<CashForecast13>> {
  const fallback = 'Could not load the 13-week forecast - try again.';
  return shaped(await call(BASE, undefined, fallback), isForecast, fallback);
}

export async function fetchOverrides(): Promise<ApiResult<StoredOverride[]>> {
  const fallback = 'Could not load your changes to the forecast.';
  const r = shaped(await call(`${BASE}/overrides`, undefined, fallback), (d): d is { overrides: StoredOverride[] } => isObj(d) && Array.isArray(d.overrides), fallback);
  return r.ok ? { ok: true, data: r.data.overrides } : r;
}

export async function fetchItems(): Promise<ApiResult<StoredItem[]>> {
  const fallback = 'Could not load your expected items.';
  const r = shaped(await call(`${BASE}/items`, undefined, fallback), (d): d is { items: StoredItem[] } => isObj(d) && Array.isArray(d.items), fallback);
  return r.ok ? { ok: true, data: r.data.items } : r;
}

export async function fetchPayDay(): Promise<ApiResult<PayDaySetting>> {
  const fallback = 'Could not load the pay day.';
  return shaped(await call(`${BASE}/pay-day`, undefined, fallback), (d): d is PayDaySetting => isObj(d) && isObj(d.payDay), fallback);
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
