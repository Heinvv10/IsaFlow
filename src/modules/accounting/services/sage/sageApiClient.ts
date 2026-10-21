/**
 * Client for the official South African Sage Business Cloud Accounting API
 * (https://accounting.sageone.co.za/api/2.0.0).
 *
 * Auth is Sage's own: IsaFlow's vendor key in the `apikey` query parameter,
 * the client's Sage login as HTTP Basic auth, and `companyid` on every
 * company-scoped call. The login is held only for the life of the client —
 * never stored, never logged, never put in an error message.
 *
 * Sage's limits: 100 requests a minute per company (going over blocks the IP
 * for an hour), 5000 a day, at most 100 rows per list call. Calls are spaced
 * (`minIntervalMs`), lists are paged with $top/$skip, and a throttled or
 * failed call is retried with backoff before it is reported.
 */
import { safeFetch } from '@/lib/safeFetch';
import type { SageCompanySummary, SagePaged } from './sageApiTypes';

export const SAGE_API_BASE = 'https://accounting.sageone.co.za/api/2.0.0';
const PAGE_SIZE = 100;

export type SageApiErrorKind = 'not_configured' | 'auth' | 'forbidden' | 'rate_limited' | 'unavailable' | 'bad_response';

const MESSAGES: Record<SageApiErrorKind, string> = {
  not_configured: 'The Sage connection is not switched on for IsaFlow yet. Use the file upload instead, or ask IsaFlow support.',
  auth: 'Sage did not accept that email address or password. Use the details you sign in to Sage Accounting with.',
  forbidden: 'Sage refused the request. Your Sage user may not have access to this company, or Sage has paused requests from IsaFlow for a while. Try again later.',
  rate_limited: 'Sage is limiting how fast IsaFlow can read your data. Wait a few minutes and try again.',
  unavailable: 'Sage is not responding right now. Try again in a few minutes.',
  bad_response: 'Sage sent back something IsaFlow could not read.',
};

export class SageApiError extends Error {
  constructor(public readonly kind: SageApiErrorKind, public readonly status?: number, detail?: string) {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind]);
    this.name = 'SageApiError';
  }
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface SageApiClientOptions {
  apiKey: string;
  username: string;
  password: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  /** Gap between calls; 700 ms keeps one pull under Sage's 100 a minute. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultFetch: FetchImpl = (url, init) => safeFetch(url, init, { allowHosts: ['sageone.co.za'], timeoutMs: 60_000 });
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SageCompanyClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: unknown, query?: Record<string, string>): Promise<T>;
  /** Every row of a paged list. */
  getAll<T>(path: string, query?: Record<string, string>): Promise<T[]>;
}

export interface SageApiClient {
  listCompanies(): Promise<SageCompanySummary[]>;
  forCompany(companyId: number): SageCompanyClient;
}

export function createSageApiClient(opts: SageApiClientOptions): SageApiClient {
  if (!opts.apiKey?.trim()) throw new SageApiError('not_configured');
  const base = (opts.baseUrl ?? SAGE_API_BASE).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 700;
  const maxRetries = opts.maxRetries ?? 3;
  const authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
  let lastCall: number | null = null;

  async function pace(): Promise<void> {
    if (lastCall !== null && minInterval > 0) {
      const wait = minInterval - (now() - lastCall);
      if (wait > 0) await sleep(wait);
    }
    lastCall = now();
  }

  async function call<T>(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    url.searchParams.set('apikey', opts.apiKey);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const init: RequestInit = {
      method,
      headers: { Authorization: authorization, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let last: SageApiError = new SageApiError('unavailable');
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
      await pace();
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), init);
      } catch (err) {
        last = new SageApiError('unavailable', undefined, err instanceof Error ? err.name : undefined);
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        if (!text) return undefined as T;
        try { return JSON.parse(text) as T; } catch { throw new SageApiError('bad_response', res.status); }
      }
      if (res.status === 401) throw new SageApiError('auth', 401);
      if (res.status === 403) throw new SageApiError('forbidden', 403);
      if (res.status === 429) { last = new SageApiError('rate_limited', 429); continue; }
      if (res.status >= 500) { last = new SageApiError('unavailable', res.status); continue; }
      throw new SageApiError('bad_response', res.status, `HTTP ${res.status} from ${path}`);
    }
    throw last;
  }

  function forCompany(companyId: number): SageCompanyClient {
    const scoped = (q: Record<string, string> = {}) => ({ ...q, companyid: String(companyId) });
    return {
      get: <T>(path: string, query?: Record<string, string>) => call<T>('GET', path, scoped(query)),
      post: <T>(path: string, body: unknown, query?: Record<string, string>) => call<T>('POST', path, scoped(query), body),
      async getAll<T>(path: string, query?: Record<string, string>): Promise<T[]> {
        const rows: T[] = [];
        for (let skip = 0; ; skip += PAGE_SIZE) {
          const page = await call<SagePaged<T> | T[]>('GET', path, scoped({ ...query, $top: String(PAGE_SIZE), $skip: String(skip) }));
          const results = Array.isArray(page) ? page : page?.Results ?? [];
          rows.push(...results);
          const total = Array.isArray(page) ? undefined : page?.TotalResults;
          if (results.length < PAGE_SIZE || (total !== undefined && rows.length >= total)) return rows;
        }
      },
    };
  }

  return {
    async listCompanies() {
      const page = await call<SagePaged<SageCompanySummary> | SageCompanySummary[]>('GET', 'Company/Get', {});
      return Array.isArray(page) ? page : page?.Results ?? [];
    },
    forCompany,
  };
}
