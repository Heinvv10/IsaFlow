/**
 * Microsoft Graph, app-only (client credentials), for the POP archive copy (popArchiveSweep.ts).
 * Credentials: POP_ARCHIVE_TENANT_ID, POP_ARCHIVE_CLIENT_ID, POP_ARCHIVE_CLIENT_SECRET. `fetch` is
 * injected so tests make no network call.
 *
 * Upload is the simple PUT (files up to 4 MB) with conflictBehavior=fail: an existing file is never
 * overwritten. A 409 (the name exists) reads the item at that path and adopts it only if it is a file of
 * exactly our size (and our SHA-256 / SHA-1, when Graph reports one): the name carries ABSA's transaction
 * number, so such a file is this payment's copy from an earlier tick whose record did not commit.
 * Each call starts only with GRAPH_MIN_REQUEST_MS left before the caller's deadline, and is cut off at it.
 */
import { createHash } from 'crypto';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * ok: archived (existed: adopted after a 409). The rest record nothing about the POP and stop the company's
 * sweep for this tick: throttled (429, or 503 with Retry-After), denied (401/403: the app's access, not this
 * file), deadline (no time left for the call). failed: this POP's attempt failed (transient: a 5xx or the
 * network, after which the sweep also stops for the tick).
 */
export type UploadResult =
  | { kind: 'ok'; driveItemId: string; webUrl: string | null; existed: boolean }
  | { kind: 'throttled'; status: number; retryAfterSec: number | null }
  | { kind: 'denied'; status: number }
  | { kind: 'deadline' }
  | { kind: 'failed'; status: number; detail: string; transient: boolean };

/** Graph's simple upload takes up to 4 MB. */
export const MAX_SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
/** One Graph or token request may take this long (a 4 MB PUT included). */
export const GRAPH_REQUEST_TIMEOUT_MS = 30_000;
/** A request is not started with less than this left before the caller's deadline. */
export const GRAPH_MIN_REQUEST_MS = 5_000;
/** A cached token is renewed this long before Graph says it expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** The token request failed: nothing can be uploaded with these credentials right now. */
export class GraphTokenError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphTokenError'; }
}

export function popArchiveCredentials(env: NodeJS.ProcessEnv = process.env): GraphCredentials | null {
  const tenantId = env.POP_ARCHIVE_TENANT_ID?.trim();
  const clientId = env.POP_ARCHIVE_CLIENT_ID?.trim();
  const clientSecret = env.POP_ARCHIVE_CLIENT_SECRET?.trim();
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

export class PopGraphClient {
  constructor(
    private readonly creds: GraphCredentials,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly cache: Map<string, CachedToken> = tokenCache,
  ) {}

  private get cacheKey(): string {
    return `${this.creds.tenantId}:${this.creds.clientId}`;
  }

  /** A cached or fresh token; throws GraphTokenError when Graph will not issue one. */
  async token(): Promise<string> {
    const held = this.cache.get(this.cacheKey);
    if (held && held.expiresAt - TOKEN_EXPIRY_MARGIN_MS > this.now()) return held.token;
    let res: Response;
    try {
      res = await this.fetchFn(
        `https://login.microsoftonline.com/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`, {
          method: 'POST',
          signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials', client_id: this.creds.clientId,
            client_secret: this.creds.clientSecret, scope: 'https://graph.microsoft.com/.default',
          }).toString(),
        });
    } catch (err) {
      throw new GraphTokenError(`Graph token request failed: ${err instanceof Error ? err.name : 'network'}`);
    }
    // The body of a refused token request can echo request details; only the status is reported.
    if (!res.ok) throw new GraphTokenError(`Graph token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new GraphTokenError('Graph token response has no access_token');
    const seconds = Number(body.expires_in);
    const expiresAt = this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    this.cache.set(this.cacheKey, { token: body.access_token, expiresAt });
    return body.access_token;
  }

  /** PUT a new file at `encodedPath` (popArchiveName.encodeDrivePath) in the site's default library. */
  async uploadNew(siteId: string, encodedPath: string, bytes: Buffer, deadline: number = Number.POSITIVE_INFINITY): Promise<UploadResult> {
    const item = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drive/root:/${encodedPath}`;
    const put = await this.call(`${item}:/content?@microsoft.graph.conflictBehavior=fail`, {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes),
    }, deadline);
    if (!(put instanceof Response)) return put;
    if (put.status === 200 || put.status === 201) {
      const got = await driveItem(put);
      return got ? { kind: 'ok', ...got, existed: false } : { kind: 'failed', status: put.status, detail: 'no item id', transient: false };
    }
    if (put.status !== 409) return refusal(put);
    const found = await this.call(`${item}?$select=id,webUrl,size,file`, { method: 'GET' }, deadline);
    if (!(found instanceof Response)) return found;
    if (found.status !== 200) {
      const r = await refusal(found);
      return r.kind === 'failed' ? { ...r, detail: `exists, lookup failed: ${r.detail}` } : r;
    }
    const existing = (await found.json()) as ExistingItem;
    const got = driveItem200(existing);
    if (!got || !sameFile(existing, bytes)) return { kind: 'failed', status: 409, detail: 'exists_differs', transient: false };
    return { kind: 'ok', ...got, existed: true };
  }

  /** One authorised request, or why it was not made / did not answer. */
  private async call(url: string, init: RequestInit, deadline: number): Promise<Response | UploadResult> {
    const left = deadline - this.now();
    if (left < GRAPH_MIN_REQUEST_MS) return { kind: 'deadline' };
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(Math.min(GRAPH_REQUEST_TIMEOUT_MS, left)),
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    } catch (err) {
      return { kind: 'failed', status: 0, detail: `network: ${err instanceof Error ? err.name : 'error'}`, transient: true };
    }
    if (res.status === 401) this.cache.delete(this.cacheKey); // a revoked token is not reused next tick
    return res;
  }
}

interface ExistingItem { id?: unknown; webUrl?: unknown; size?: unknown; file?: { hashes?: { sha256Hash?: unknown; sha1Hash?: unknown } } }

/** The existing item is a file of our size, and of our hash where Graph reports SHA-256 or SHA-1. */
function sameFile(item: ExistingItem, bytes: Buffer): boolean {
  if (!item.file || typeof item.file !== 'object' || item.size !== bytes.length) return false;
  const { sha256Hash, sha1Hash } = item.file.hashes ?? {};
  const differs = (reported: unknown, algo: 'sha256' | 'sha1') => typeof reported === 'string'
    && reported.toLowerCase() !== createHash(algo).update(bytes).digest('hex');
  return !differs(sha256Hash, 'sha256') && !differs(sha1Hash, 'sha1');
}

function driveItem200(body: ExistingItem): { driveItemId: string; webUrl: string | null } | null {
  return typeof body.id === 'string' && body.id ? { driveItemId: body.id, webUrl: typeof body.webUrl === 'string' ? body.webUrl : null } : null;
}

async function driveItem(res: Response): Promise<{ driveItemId: string; webUrl: string | null } | null> {
  return driveItem200((await res.json()) as ExistingItem);
}

/** A non-2xx, non-409 answer, classified. */
async function refusal(res: Response): Promise<UploadResult> {
  const retryAfter = Number(res.headers.get('retry-after'));
  const retryAfterSec = Number.isFinite(retryAfter) && retryAfter >= 0 && res.headers.has('retry-after') ? retryAfter : null;
  if (res.status === 429 || (res.status === 503 && retryAfterSec !== null)) return { kind: 'throttled', status: res.status, retryAfterSec };
  if (res.status === 401 || res.status === 403) return { kind: 'denied', status: res.status };
  return { kind: 'failed', status: res.status, detail: await errorCode(res), transient: res.status >= 500 };
}

/** Graph's error code (e.g. "accessDenied"), never the whole body. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code.slice(0, 100) : `HTTP ${res.status}`;
  } catch (err) {
    return `HTTP ${res.status} (${err instanceof Error ? err.name : 'unreadable body'})`;
  }
}
