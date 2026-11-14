/**
 * Microsoft Graph, app-only (client credentials), for the POP archive copy (popArchiveSweep.ts).
 * Credentials: POP_ARCHIVE_TENANT_ID, POP_ARCHIVE_CLIENT_ID, POP_ARCHIVE_CLIENT_SECRET. `fetch` is
 * injected so tests make no network call.
 *
 * Upload is the simple PUT (files up to 4 MB) with conflictBehavior=fail: an existing file is never
 * overwritten. A 409 (the name exists) is answered by reading the item at that path: the name carries
 * ABSA's transaction number, so an existing file is this payment's copy from an earlier tick whose
 * record did not commit.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export type UploadResult =
  | { ok: true; driveItemId: string; webUrl: string | null; existed: boolean }
  | { ok: false; status: number; detail: string };

/** Graph's simple upload takes up to 4 MB. */
export const MAX_SIMPLE_UPLOAD_BYTES = 4 * 1024 * 1024;
/** One Graph or token request may take this long (a 4 MB PUT included). */
export const GRAPH_REQUEST_TIMEOUT_MS = 30_000;
/** A cached token is renewed this long before Graph says it expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;

const GRAPH = 'https://graph.microsoft.com/v1.0';

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

  async token(): Promise<string> {
    const held = this.cache.get(this.cacheKey);
    if (held && held.expiresAt - TOKEN_EXPIRY_MARGIN_MS > this.now()) return held.token;
    const res = await this.fetchFn(
      `https://login.microsoftonline.com/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials', client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret, scope: 'https://graph.microsoft.com/.default',
        }).toString(),
      });
    // The body of a refused token request can echo request details; only the status is reported.
    if (!res.ok) throw new Error(`Graph token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('Graph token response has no access_token');
    const seconds = Number(body.expires_in);
    const expiresAt = this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    this.cache.set(this.cacheKey, { token: body.access_token, expiresAt });
    return body.access_token;
  }

  /** PUT a new file at `encodedPath` (popArchiveName.encodeDrivePath) in the site's default library. */
  async uploadNew(siteId: string, encodedPath: string, bytes: Buffer): Promise<UploadResult> {
    const item = `${GRAPH}/sites/${encodeURIComponent(siteId)}/drive/root:/${encodedPath}`;
    const res = await this.authed(`${item}:/content?@microsoft.graph.conflictBehavior=fail`, {
      method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes),
    });
    if (res.status === 200 || res.status === 201) return { ...(await driveItem(res)), existed: false };
    if (res.status !== 409) return { ok: false, status: res.status, detail: await errorCode(res) };
    const found = await this.authed(item, { method: 'GET' });
    if (found.status !== 200) return { ok: false, status: found.status, detail: `exists, lookup failed: ${await errorCode(found)}` };
    return { ...(await driveItem(found)), existed: true };
  }

  private async authed(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS), headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401) this.cache.delete(this.cacheKey); // a revoked token is not reused next tick
    return res;
  }
}

async function driveItem(res: Response): Promise<{ ok: true; driveItemId: string; webUrl: string | null }> {
  const body = (await res.json()) as { id?: unknown; webUrl?: unknown };
  if (typeof body.id !== 'string' || !body.id) throw new Error('Graph drive item response has no id');
  return { ok: true, driveItemId: body.id, webUrl: typeof body.webUrl === 'string' ? body.webUrl : null };
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
