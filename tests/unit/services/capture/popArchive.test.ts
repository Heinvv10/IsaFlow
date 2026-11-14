/**
 * POP SharePoint archive, pure and HTTP parts: the file name (popArchiveName.ts) and the Graph client
 * (popGraphClient.ts) against a stubbed fetch: token request and cache, upload 201, 409 → lookup of the
 * existing item, 5xx → not recorded as archived, 401 drops the cached token.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeDrivePath, popArchivePath, sanitizeFolderPath, sanitizeSharePointName,
} from '@/modules/accounting/services/capture/pop/popArchiveName';
import { PopGraphClient, popArchiveCredentials, TOKEN_EXPIRY_MARGIN_MS } from '@/modules/accounting/services/capture/pop/popGraphClient';

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
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

describe('PopGraphClient', () => {
  it('gets a client-credentials token, then PUTs the bytes with conflictBehavior=fail', async () => {
    const { client, calls } = graph([token, () => json(201, { id: 'item-1', webUrl: 'https://sp/x.pdf' })]);
    const r = await client.uploadNew('site,1,2', PATH, Buffer.from('%PDF-1.4'));
    expect(r).toEqual({ ok: true, driveItemId: 'item-1', webUrl: 'https://sp/x.pdf', existed: false });

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
    await client.uploadNew('s', PATH, Buffer.from('x'));
    t += 3600_000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    await client.uploadNew('s', PATH, Buffer.from('x'));
    t += 2;
    await client.uploadNew('s', PATH, Buffer.from('x'));
    expect(calls.map((c) => c.url.includes('login.microsoftonline.com'))).toEqual([true, false, false, true, false]);
    expect((calls[4]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
  });

  it('on 409 reads the existing item at that path and reports it as existing', async () => {
    const { client, calls } = graph([token, () => json(409, { error: { code: 'nameAlreadyExists' } }),
      () => json(200, { id: 'item-old', webUrl: 'https://sp/old.pdf' })]);
    expect(await client.uploadNew('s', PATH, Buffer.from('x')))
      .toEqual({ ok: true, driveItemId: 'item-old', webUrl: 'https://sp/old.pdf', existed: true });
    expect(calls[2]!.url).toBe(`https://graph.microsoft.com/v1.0/sites/s/drive/root:/${PATH}`);
    expect(calls[2]!.init!.method).toBe('GET');
  });

  it('reports a 5xx as a failure, with Graph\'s error code only', async () => {
    const { client } = graph([token, () => json(503, { error: { code: 'serviceNotAvailable', message: 'long text' } })]);
    expect(await client.uploadNew('s', PATH, Buffer.from('x'))).toEqual({ ok: false, status: 503, detail: 'serviceNotAvailable' });
  });

  it('reports a 409 whose lookup fails as a failure', async () => {
    const { client } = graph([token, () => json(409, {}), () => json(404, { error: { code: 'itemNotFound' } })]);
    expect(await client.uploadNew('s', PATH, Buffer.from('x')))
      .toEqual({ ok: false, status: 404, detail: 'exists, lookup failed: itemNotFound' });
  });

  it('throws on a refused token request without echoing its body, and drops a token Graph answers 401 to', async () => {
    const refused = graph([() => json(400, { error: 'invalid_client', error_description: 'secret-1 is wrong' })]);
    await expect(refused.client.uploadNew('s', PATH, Buffer.from('x'))).rejects.toThrow(/^Graph token request failed: HTTP 400$/);

    const { client, calls } = graph([token, () => json(401, {}), token, () => json(201, { id: 'z' })]);
    expect((await client.uploadNew('s', PATH, Buffer.from('x'))).ok).toBe(false);
    expect((await client.uploadNew('s', PATH, Buffer.from('x'))).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });
});
