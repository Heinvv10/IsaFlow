/**
 * The GET-only Sage client. One function sends requests and its method is the literal 'GET'.
 *
 * - Paths are built from endpoints.ts: `{Resource}/Get`, `{Resource}/Get/{id}` or the attachment
 *   download. Ids must be digits, so nothing can be appended to a path.
 * - An OData filter is passed as ONE query value. Characters that could start another parameter
 *   or a fragment (& ? # and control characters) are refused, so a filter cannot add or replace
 *   apikey/companyid.
 * - 401/403 is recorded in the failure ledger and never retried (lockout.ts).
 * - Error messages carry the status and resource only: never the URL (it holds the api key), the
 *   username or the Authorization header.
 * - Any field whose name mentions delete is dropped from replies (brief: never expose delete urls).
 */
import type { SageConfig } from './config';
import { LoginFailureLedger } from './lockout';
import { ATTACHMENT_DOWNLOAD_PATH, RESOURCES, type SageResourceName } from './endpoints';

export const PAGE_SIZE = 100;
const TIMEOUT_MS = 30_000;
const MAX_FILTER_LENGTH = 1000;

export class SageRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export interface SageListPage<T = Record<string, unknown>> {
  totalResults: number;
  returnedResults: number;
  results: T[];
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export function assertSafeFilter(filter: string): void {
  if (filter.length > MAX_FILTER_LENGTH) throw new SageRequestError(`filter is longer than ${MAX_FILTER_LENGTH} characters`, null);
  if (/[&?#\u0000-\u001f]/.test(filter)) {
    throw new SageRequestError('filter may not contain & ? # or control characters', null);
  }
}

function assertId(id: string | number): string {
  const s = String(id);
  if (!/^\d{1,18}$/.test(s)) throw new SageRequestError('id must be a Sage numeric id', null);
  return s;
}

/** Removes delete links/flags at any depth; Sage replies are plain JSON. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/delete/i.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export class SageClient {
  private readonly ledger: LoginFailureLedger;

  constructor(private readonly config: SageConfig, private readonly fetchImpl: FetchLike = fetch, ledger?: LoginFailureLedger) {
    this.ledger = ledger ?? new LoginFailureLedger(config.stateDir);
  }

  private url(path: string, query: Record<string, string>): string {
    const params = new URLSearchParams({ ...query, apikey: this.config.apiKey, companyid: this.config.companyId });
    return `${this.config.baseUrl}/${path}?${params.toString()}`;
  }

  private async send(path: string, query: Record<string, string>, label: string): Promise<Response> {
    this.ledger.assertMayAttempt();
    const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, query), {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new SageRequestError(`Sage ${label}: ${reason}`, null);
    }
    if (res.status === 401 || res.status === 403) {
      this.ledger.recordFailure();
      throw new SageRequestError(
        `Sage ${label}: login refused (${res.status}). Not retried; ${this.ledger.failuresInWindow()} failed login(s) `
        + 'this hour. Check the integration user in the env file.',
        res.status,
      );
    }
    if (!res.ok) throw new SageRequestError(`Sage ${label}: HTTP ${res.status}`, res.status);
    return res;
  }

  private async json(path: string, query: Record<string, string>, label: string): Promise<unknown> {
    const res = await this.send(path, query, label);
    try {
      return scrub(await res.json());
    } catch {
      throw new SageRequestError(`Sage ${label}: reply was not JSON`, res.status);
    }
  }

  /** One page of `{Resource}/Get`. `page` is zero-based. */
  async list(resource: SageResourceName, opts: { filter?: string; orderBy?: string; page?: number } = {}): Promise<SageListPage> {
    const def = RESOURCES[resource];
    const query: Record<string, string> = { ...def.detailQuery, $top: String(PAGE_SIZE), $skip: String((opts.page ?? 0) * PAGE_SIZE) };
    if (opts.filter) { assertSafeFilter(opts.filter); query.$filter = opts.filter; }
    if (opts.orderBy) { assertSafeFilter(opts.orderBy); query.$orderby = opts.orderBy; }
    const body = (await this.json(`${def.path}/Get`, query, `${resource} list`)) as Record<string, unknown>;
    const results = Array.isArray(body.Results) ? (body.Results as Record<string, unknown>[]) : [];
    return {
      totalResults: typeof body.TotalResults === 'number' ? body.TotalResults : results.length,
      returnedResults: typeof body.ReturnedResults === 'number' ? body.ReturnedResults : results.length,
      results,
    };
  }

  /** `{Resource}/Get/{id}`. */
  async get(resource: SageResourceName, id: string | number): Promise<Record<string, unknown>> {
    const def = RESOURCES[resource];
    return (await this.json(`${def.path}/Get/${assertId(id)}`, { ...def.detailQuery }, `${resource} ${id}`)) as Record<string, unknown>;
  }

  /** Raw bytes of one attachment, with the content type Sage sent. */
  async download(id: string | number): Promise<{ bytes: Buffer; contentType: string | null }> {
    const res = await this.send(`${ATTACHMENT_DOWNLOAD_PATH}/${assertId(id)}`, {}, `attachment ${id}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }
}
