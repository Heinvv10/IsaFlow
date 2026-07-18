/**
 * OAuth discovery endpoints (RFC 8414 / RFC 9728) — MCP Phase 1, Task 1.2.
 *
 * Contract under test: unauthenticated JSON documents that let Claude-family
 * clients discover the authorize/token/register endpoints and the protected
 * resource with zero manual setup. scopes_supported must track OAUTH_SCOPES.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { OAUTH_SCOPES } from '@/lib/auth/oauth';
import metadataHandler from '../../../pages/api/oauth/metadata';
import resourceMetadataHandler from '../../../pages/api/oauth/resource-metadata';

interface FakeRes {
  statusCode: number;
  body?: Record<string, unknown>;
  headers: Record<string, unknown>;
}

function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    body: undefined as FakeRes['body'],
    setHeader(k: string, v: unknown) { res.headers[k.toLowerCase()] = v; return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: FakeRes['body']) { res.body = b; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}

function makeReq(method = 'GET'): NextApiRequest {
  return { method, headers: {}, url: '/.well-known/x' } as unknown as NextApiRequest;
}

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('OAUTH_SCOPES vocabulary', () => {
  it('includes the MCP read scopes (contacts, vat) — scopes_supported auto-tracks', () => {
    expect(OAUTH_SCOPES).toContain('read:contacts');
    expect(OAUTH_SCOPES).toContain('read:vat');
  });
});

describe('GET /.well-known/oauth-authorization-server (metadata)', () => {
  it('serves the RFC 8414 document with all endpoints on the app origin', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = makeRes();
    await metadataHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const b = res.body!;
    expect(b.issuer).toBe('https://app.isaflow.co.za');
    expect(String(b.authorization_endpoint)).toMatch(/\/oauth\/authorize$/);
    expect(String(b.token_endpoint)).toMatch(/\/api\/oauth\/token$/);
    expect(String(b.registration_endpoint)).toMatch(/\/api\/oauth\/register$/);
    expect(b.code_challenge_methods_supported).toEqual(['S256']);
    expect(b.token_endpoint_auth_methods_supported).toContain('none');
    expect(b.response_types_supported).toContain('code');
    expect(b.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(b.scopes_supported).toEqual([...OAUTH_SCOPES]);
  });

  it('derives the origin from NEXT_PUBLIC_APP_URL when set', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3200';
    const res = makeRes();
    await metadataHandler(makeReq(), res);
    expect(res.body!.issuer).toBe('http://localhost:3200');
    expect(res.body!.token_endpoint).toBe('http://localhost:3200/api/oauth/token');
  });

  it('is cacheable for 5 minutes and rejects non-GET methods', async () => {
    const res = makeRes();
    await metadataHandler(makeReq(), res);
    expect(res.headers['cache-control']).toBe('public, max-age=300');

    const post = makeRes();
    await metadataHandler(makeReq('POST'), post);
    expect(post.statusCode).toBe(405);
  });
});

describe('GET /.well-known/oauth-protected-resource (resource metadata)', () => {
  it('serves the RFC 9728 document pointing at /api/mcp with header-only bearer', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const res = makeRes();
    await resourceMetadataHandler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const b = res.body!;
    expect(String(b.resource)).toMatch(/\/api\/mcp$/);
    expect(b.resource).toBe('https://app.isaflow.co.za/api/mcp');
    expect(b.bearer_methods_supported).toEqual(['header']);
    expect(b.authorization_servers).toEqual(['https://app.isaflow.co.za']);
    expect(b.scopes_supported).toEqual([...OAUTH_SCOPES]);
  });

  it('is cacheable for 5 minutes and rejects non-GET methods', async () => {
    const res = makeRes();
    await resourceMetadataHandler(makeReq(), res);
    expect(res.headers['cache-control']).toBe('public, max-age=300');

    const post = makeRes();
    await resourceMetadataHandler(makeReq('POST'), post);
    expect(post.statusCode).toBe(405);
  });
});
