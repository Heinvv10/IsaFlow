/** Pure: the request shapes of the intercompany inbox routes (400 before any cast reaches SQL). */
import { isUuidParam } from '@/lib/validation';
import { checkReason } from './handleService';
import type { AcceptInput, InboxFilter } from './inboxTypes';

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseInboxQuery(query: Record<string, unknown>): Parsed<{ filter: InboxFilter; limit: number; offset: number }> {
  const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const filter = one(query.filter) ?? 'open';
  if (filter !== 'open' && filter !== 'handled') return { ok: false, error: "filter must be 'open' or 'handled'" };
  const num = (raw: string | undefined, name: string, def: number, max: number): number | string => {
    if (raw === undefined) return def;
    if (!/^\d{1,6}$/.test(raw)) return `${name} must be a whole number`;
    return Math.min(Number(raw), max);
  };
  const limit = num(one(query.limit), 'limit', 25, 100);
  const offset = num(one(query.offset), 'offset', 0, 1_000_000);
  if (typeof limit === 'string') return { ok: false, error: limit };
  if (typeof offset === 'string') return { ok: false, error: offset };
  return { ok: true, value: { filter, limit: Math.max(limit, 1), offset } };
}

/** The Accept body: optional; `lineAccounts` maps a line index to an account id, `accountId` is a credit note's account. */
export function parseAcceptBody(body: unknown): Parsed<AcceptInput> {
  if (body === undefined || body === null || (isObject(body) && Object.keys(body).length === 0)) return { ok: true, value: {} };
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = Object.keys(body).find((k) => k !== 'lineAccounts' && k !== 'accountId');
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };
  const value: AcceptInput = {};
  if (body.accountId !== undefined) {
    if (!isUuidParam(body.accountId)) return { ok: false, error: 'accountId must be a valid UUID' };
    value.accountId = body.accountId.toLowerCase();
  }
  if (body.lineAccounts !== undefined) {
    if (!isObject(body.lineAccounts)) return { ok: false, error: 'lineAccounts must be an object of line index to account id' };
    const entries = Object.entries(body.lineAccounts);
    if (entries.length > 500) return { ok: false, error: 'lineAccounts has too many entries' };
    const map: Record<number, string> = {};
    for (const [k, v] of entries) {
      if (!/^\d{1,3}$/.test(k)) return { ok: false, error: 'lineAccounts keys must be line numbers' };
      if (!isUuidParam(v)) return { ok: false, error: `The account for line ${Number(k) + 1} must be a valid UUID` };
      map[Number(k)] = v.toLowerCase();
    }
    value.lineAccounts = map;
  }
  return { ok: true, value };
}

export function parseRejectBody(body: unknown): Parsed<{ reason: string }> {
  if (!isObject(body)) return { ok: false, error: 'A JSON object body is required' };
  const extra = Object.keys(body).find((k) => k !== 'reason');
  if (extra) return { ok: false, error: `Unknown field: ${extra}` };
  const r = checkReason(body.reason);
  return r.ok ? { ok: true, value: { reason: r.reason } } : { ok: false, error: r.error };
}
