/**
 * Request + row-narrowing for the pickers. Every call goes through apiJson (it throws on a non-2xx and on a body
 * that is not the { success, data } envelope), then each row is checked for the fields the picker reads - a route
 * that changes shape fails loudly as the picker's error state rather than rendering blank options.
 */

import { apiJson, ApiEnvelopeError } from '@/lib/apiFetch';
import type { SelectOption } from '../Select';

type Row = Record<string, unknown>;

function rows(data: unknown, what: string): Row[] {
  if (!Array.isArray(data)) throw new ApiEnvelopeError(`Unexpected response while loading ${what}`);
  return data as Row[];
}

function text(row: Row, key: string, what: string): string {
  const v = row[key];
  if (typeof v !== 'string' || v === '') throw new ApiEnvelopeError(`Unexpected ${what} record (missing ${key})`);
  return v;
}

function optText(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

export type ContactKind = 'customer' | 'supplier';

export async function fetchContacts(kind: ContactKind, query: string, signal: AbortSignal): Promise<SelectOption[]> {
  const q = encodeURIComponent(query.trim());
  const what = `${kind}s`;
  let list: Row[];
  if (kind === 'customer') {
    list = rows(await apiJson(`/api/accounting/customers?q=${q}`, { signal }, 'Could not load customers - try again'), what);
  } else {
    const body = await apiJson(`/api/accounting/suppliers-list?limit=50&q=${q}`, { signal }, 'Could not load suppliers - try again');
    list = rows((body as { suppliers?: unknown } | null)?.suppliers, what);
  }
  return list.map((r) => ({ value: text(r, 'id', kind), label: text(r, 'name', kind) }));
}

export async function fetchItems(query: string, signal: AbortSignal): Promise<SelectOption[]> {
  const q = encodeURIComponent(query.trim());
  const data = await apiJson(`/api/accounting/items?active=true&q=${q}`, { signal }, 'Could not load items - try again');
  return rows(data, 'items').map((r) => {
    const code = text(r, 'code', 'item');
    const description = optText(r, 'description');
    return { value: text(r, 'id', 'item'), label: description ? `${code} · ${description}` : code };
  });
}

export interface AccountRow {
  option: SelectOption;
  accountType: string;
  accountSubtype: string;
}

/** The whole active chart (the route takes no search parameter); the account picker filters it locally. */
export async function fetchAccountRows(signal: AbortSignal): Promise<AccountRow[]> {
  const data = await apiJson('/api/accounting/chart-of-accounts', { signal }, 'Could not load accounts - try again');
  return rows(data, 'accounts').map((r) => ({
    option: { value: text(r, 'id', 'account'), label: `${text(r, 'accountCode', 'account')} · ${text(r, 'accountName', 'account')}` },
    accountType: optText(r, 'accountType'),
    accountSubtype: optText(r, 'accountSubtype'),
  }));
}
