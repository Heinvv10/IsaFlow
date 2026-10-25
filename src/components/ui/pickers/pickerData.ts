/**
 * Request + row-narrowing for the pickers. Every call goes through apiJson (it throws on a non-2xx and on a body
 * that is not the { success, data } envelope), then each row is checked for the fields the picker reads - a route
 * that changes shape fails loudly as the picker's error state rather than rendering blank options.
 *
 * Page sizes: the empty query (what opening shows) asks for 20 rows, a typed query for 50. When the server may
 * have had more, the result carries a hint so a short list is never mistaken for the whole directory.
 */

import { apiJson, ApiEnvelopeError, ApiRequestError } from '@/lib/apiFetch';
import { UUID_RE } from '@/lib/validation';
import type { SelectOption } from '../Select';
import type { FetchResult } from './useRemoteOptions';

type Row = Record<string, unknown>;

const OPEN_PAGE = 20;
const SEARCH_PAGE = 50;
const pageSize = (query: string) => (query.trim() === '' ? OPEN_PAGE : SEARCH_PAGE);
const truncatedHint = (shown: number, query: string) =>
  `Showing the first ${shown} - ${query.trim() === '' ? 'type to search' : 'keep typing to narrow'}`;

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

export async function fetchContacts(kind: ContactKind, query: string, signal: AbortSignal): Promise<FetchResult> {
  const q = encodeURIComponent(query.trim());
  const limit = pageSize(query);
  const what = `${kind}s`;
  let list: Row[];
  let truncated: boolean;
  if (kind === 'customer') {
    list = rows(await apiJson(`/api/accounting/customers?limit=${limit}&q=${q}`, { signal }, 'Could not load customers - try again'), what);
    truncated = list.length >= limit;
  } else {
    const body = (await apiJson(`/api/accounting/suppliers-list?limit=${limit}&q=${q}`, { signal }, 'Could not load suppliers - try again')) as
      { suppliers?: unknown; total?: unknown } | null;
    list = rows(body?.suppliers, what);
    truncated = typeof body?.total === 'number' ? body.total > list.length : list.length >= limit;
  }
  // Inactive contacts are not offered for new documents (a saved one is still named by contactLabel).
  const options = list.filter((r) => r.is_active !== false).map((r) => ({ value: text(r, 'id', kind), label: text(r, 'name', kind) }));
  return { options, hint: truncated ? truncatedHint(list.length, query) : undefined };
}

/** The name of one contact by id, active or not; null when it does not exist (or is not this company's). */
export async function fetchContactLabel(kind: ContactKind, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  const url = kind === 'customer' ? `/api/accounting/customers?id=${id}` : `/api/accounting/suppliers-list?id=${id}`;
  try {
    const row = await apiJson(url, undefined, `Could not load the ${kind} - try again`);
    if (Array.isArray(row) || row === null || typeof row !== 'object') throw new ApiEnvelopeError(`Unexpected ${kind} record`);
    return text(row as Row, 'name', kind);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchItems(query: string, signal: AbortSignal): Promise<FetchResult> {
  const q = encodeURIComponent(query.trim());
  const limit = pageSize(query);
  const data = await apiJson(`/api/accounting/items?active=true&limit=${limit}&q=${q}`, { signal }, 'Could not load items - try again');
  const list = rows(data, 'items');
  const options = list.map((r) => {
    const code = text(r, 'code', 'item');
    const description = optText(r, 'description');
    return { value: text(r, 'id', 'item'), label: description ? `${code} · ${description}` : code };
  });
  return { options, hint: list.length >= limit ? truncatedHint(list.length, query) : undefined };
}

export interface AccountRow {
  option: SelectOption;
  id: string;
  accountCode: string;
  accountType: string;
  accountSubtype: string;
  parentAccountId: string | null;
  level: number | null;
  hasTransactions: boolean;
}

/**
 * The whole active chart (the route takes no search parameter); the account picker filters it locally.
 * Takes no AbortSignal on purpose: the one request is shared by every caller, and aborting it for one of them
 * (a newer keystroke, an unmount) would fail the others.
 */
export async function fetchAccountRows(): Promise<AccountRow[]> {
  const data = await apiJson('/api/accounting/chart-of-accounts', undefined, 'Could not load the chart of accounts - try again');
  return rows(data, 'accounts').map((r) => {
    const id = text(r, 'id', 'account');
    const accountCode = text(r, 'accountCode', 'account');
    return {
      option: { value: id, label: `${accountCode} · ${text(r, 'accountName', 'account')}` },
      id,
      accountCode,
      accountType: optText(r, 'accountType'),
      accountSubtype: optText(r, 'accountSubtype'),
      parentAccountId: optText(r, 'parentAccountId') || null,
      level: typeof r.level === 'number' ? r.level : null,
      hasTransactions: r.hasTransactions === true,
    };
  });
}
