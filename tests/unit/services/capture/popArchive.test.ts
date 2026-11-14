/**
 * POP SharePoint archive, pure and HTTP parts: the file name (popArchiveName.ts) and the Graph client
 * (popGraphClient.ts) against a stubbed fetch: token request and cache, upload 201, 409 → the existing item adopted
 * only when it is a file of our size and hash, throttling / denial / 5xx / network classified, the deadline.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeDrivePath, popArchivePath, sanitizeFolderPath, sanitizeSharePointName,
} from '@/modules/accounting/services/capture/pop/popArchiveName';
import { createHash } from 'crypto';
import {
  GRAPH_MIN_REQUEST_MS, GraphTokenError, PopGraphClient, popArchiveCredentials, TOKEN_EXPIRY_MARGIN_MS,
} from '@/modules/accounting/services/capture/pop/popGraphClient';

const pop = { paymentDate: '2026-11-13', beneficiary: 'Amoepong Bed and Bre', amount: '3000.00', transactionNumber: '80AB12CD34-11' };

describe('popArchivePath', () => {
  it('builds <folder>/YYYY/MM/YYYY-MM-DD <Beneficiary> R<amount> <txn>.pdf', () => {
    expect(popArchivePath('Proof of Payments', pop))
      .toBe('Proof of Payments/2026/11/2026-11-13 Amoepong Bed and Bre R3000.00 80AB12CD34-11.pdf');
  });

  it('strips what SharePoint refuses and trims spaces and dots', () => {
    expect(sanitizeSharePointName(' A"B*C:D<E>F?G/H\\I|J\u0001K  L. ')).toBe('ABCDEFGHIJK L');
    expect(popArchivePath('/Finance//POPs/', { ...pop, beneficiary: 'J/Q: "Public"...' }))
      .toBe('Finance/POPs/2026/11/2026-11-13 JQ Public... R3000.00 80AB12CD34-11.pdf');
    expect(sanitizeFolderPath(' . /Finance. ')).toBe('Finance');
  });

  it('refuses a date or amount that is not as Postgres prints it', () => {
    expect(() => popArchivePath('F', { ...pop, paymentDate: '13/11/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => popArchivePath('F', { ...pop, amount: '3000' })).toThrow(/amount/);
  });

  it('URL-encodes each path segment but keeps the slashes', () => {
    expect(encodeDrivePath('Proof of Payments/2026/11/a#b%c.pdf')).toBe('Proof%20of%20Payments/2026/11/a%23b%25c.pdf');
  });
});

describe('popArchiveCredentials', () => {
  it('is null unless all three POP_ARCHIVE_* variables are set', () => {
    expect(popArchiveCredentials({ POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c' })).toBeNull();
    expect(popArchiveCredentials({ POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c', POP_ARCHIVE_CLIENT_SECRET: ' ' })).toBeNull();
    expect(popArchiveCredentials({ POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c', POP_ARCHIVE_CLIENT_SECRET: 's' }))
      .toEqual({ tenantId: 't', clientId: 'c', clientSecret: 's' });
  });
});

type Call = { url: string; init?: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function graph(responses: Array<(call: Call) => Response>, now: () => number = () => 1_000_000) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next({ url, init });
  };
  const client = new PopGraphClient({ tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1' }, fetchFn, now, new Map());
  return { client, calls };
}
const token = () => json(200, { access_token: 'tok-1', expires_in: 3600 });
const PATH = 'Proof%20of%20Payments/2026/11/x.pdf';
const BYTES = Buffer.from('%PDF-1.4 our copy');
const sha256 = createHash('sha256').update(BYTES).digest('hex');
const exists = () => json(409, { error: { code: 'nameAlreadyExists' } });

describe('PopGraphClient', () => {
  it('gets a client-credentials token, then PUTs the bytes with conflictBehavior=fail', async () => {
    const { client, calls } = graph([token, () => json(201, { id: 'item-1', webUrl: 'https://sp/x.pdf' })]);
    const r = await client.uploadNew('site,1,2', PATH, BYTES);
    expect(r).toEqual({ kind: 'ok', driveItemId: 'item-1', webUrl: 'https://sp/x.pdf', existed: false });

    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'client-1',
      client_secret: 'secret-1', scope: 'https://graph.microsoft.com/.default' });
    expect(calls[1]!.url).toBe(`https://graph.microsoft.com/v1.0/sites/site%2C1%2C2/drive/root:/${PATH}:/content?@microsoft.graph.conflictBehavior=fail`);
    expect(calls[1]!.init!.method).toBe('PUT');
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('reuses the token until shortly before it expires', async () => {
    let t = 1_000_000;
    const { client, calls } = graph([token, () => json(201, { id: 'a' }), () => json(201, { id: 'b' }),
      () => json(200, { access_token: 'tok-2', expires_in: 3600 }), () => json(201, { id: 'c' })], () => t);
    await client.uploadNew('s', PATH, BYTES);
    t += 3600_000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    await client.uploadNew('s', PATH, BYTES);
    t += 2;
    await client.uploadNew('s', PATH, BYTES);
    expect(calls.map((c) => c.url.includes('login.microsoftonline.com'))).toEqual([true, false, false, true, false]);
    expect((calls[4]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
  });

  it('on 409 adopts the existing item only when it is a file of our size (and hash, when reported)', async () => {
    const { client, calls } = graph([token, exists,
      () => json(200, { id: 'item-old', webUrl: 'https://sp/old.pdf', size: BYTES.length, file: { hashes: { quickXorHash: 'x' } } })]);
    expect(await client.uploadNew('s', PATH, BYTES)).toEqual({ kind: 'ok', driveItemId: 'item-old', webUrl: 'https://sp/old.pdf', existed: true });
    expect(calls[2]!.url).toBe(`https://graph.microsoft.com/v1.0/sites/s/drive/root:/${PATH}?$select=id,webUrl,size,file`);
    expect(calls[2]!.init!.method).toBe('GET');

    const sameHash = graph([token, exists, () => json(200, { id: 'h', size: BYTES.length, file: { hashes: { sha256Hash: sha256.toUpperCase() } } })]);
    expect((await sameHash.client.uploadNew('s', PATH, BYTES)).kind).toBe('ok');
  });

  it('refuses to adopt a folder, a file of another size, or one whose hash differs', async () => {
    for (const body of [
      { id: 'folder', size: BYTES.length, folder: { childCount: 0 } },
      { id: 'bigger', size: BYTES.length + 1, file: {} },
      { id: 'other', size: BYTES.length, file: { hashes: { sha256Hash: 'ab'.repeat(32) } } },
      { id: 'other1', size: BYTES.length, file: { hashes: { sha1Hash: 'ab'.repeat(20) } } },
    ]) {
      const { client } = graph([token, exists, () => json(200, body)]);
      expect([body.id, await client.uploadNew('s', PATH, BYTES)])
        .toEqual([body.id, { kind: 'failed', status: 409, detail: 'exists_differs', transient: false }]);
    }
  });

  it('classifies throttling, denial, 5xx, other 4xx and network failures', async () => {
    const cases: Array<[() => Response | Promise<Response>, unknown]> = [
      [() => json(429, {}, { 'Retry-After': '30' }), { kind: 'throttled', status: 429, retryAfterSec: 30 }],
      [() => json(503, {}, { 'Retry-After': '5' }), { kind: 'throttled', status: 503, retryAfterSec: 5 }],
      [() => json(503, { error: { code: 'serviceNotAvailable', message: 'long text' } }),
        { kind: 'failed', status: 503, detail: 'serviceNotAvailable', transient: true }],
      [() => json(403, { error: { code: 'accessDenied' } }), { kind: 'denied', status: 403 }],
      [() => json(400, { error: { code: 'invalidRequest' } }), { kind: 'failed', status: 400, detail: 'invalidRequest', transient: false }],
      [() => { throw new TypeError('fetch failed'); }, { kind: 'failed', status: 0, detail: 'network: TypeError', transient: true }],
    ];
    for (const [answer, expected] of cases) {
      const { client } = graph([token, answer as (c: Call) => Response]);
      expect(await client.uploadNew('s', PATH, BYTES)).toEqual(expected);
    }
    const lookupFails = graph([token, exists, () => json(404, { error: { code: 'itemNotFound' } })]);
    expect(await lookupFails.client.uploadNew('s', PATH, BYTES))
      .toEqual({ kind: 'failed', status: 404, detail: 'exists, lookup failed: itemNotFound', transient: false });
  });

  it('starts no request with less than the minimum left before the deadline, the 409 lookup included', async () => {
    let t = 1_000_000;
    const none = graph([], () => t);
    expect(await none.client.uploadNew('s', PATH, BYTES, t + GRAPH_MIN_REQUEST_MS - 1)).toEqual({ kind: 'deadline' });
    expect(none.calls).toHaveLength(0);

    const late = graph([token, () => { t += 10_000; return exists(); }], () => t);
    expect(await late.client.uploadNew('s', PATH, BYTES, t + GRAPH_MIN_REQUEST_MS + 5_000)).toEqual({ kind: 'deadline' });
    expect(late.calls).toHaveLength(2); // token and PUT; no GET
  });

  it('throws GraphTokenError on a refused token request without echoing its body, and drops a token Graph answers 401 to', async () => {
    const refused = graph([() => json(400, { error: 'invalid_client', error_description: 'secret-1 is wrong' })]);
    const err = await refused.client.uploadNew('s', PATH, BYTES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphTokenError);
    expect((err as Error).message).toBe('Graph token request failed: HTTP 400');

    const { client, calls } = graph([token, () => json(401, {}), token, () => json(201, { id: 'z' })]);
    expect((await client.uploadNew('s', PATH, BYTES)).kind).toBe('denied');
    expect((await client.uploadNew('s', PATH, BYTES)).kind).toBe('ok');
    expect(calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });
});
