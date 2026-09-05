/**
 * getServerSideProps for /share/[token].
 *
 * The token is the whole credential, so this suite pins the three things that
 * keep it from leaking or from becoming an oracle:
 *  1. no-store + noindex are set on EVERY outcome, before anything is resolved;
 *  2. an unknown, an expired and a revoked link produce byte-identical props
 *     and the same 404 status — nothing distinguishes "never existed" from
 *     "withdrawn";
 *  3. the token never appears in the props handed to the client bundle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GetServerSidePropsContext } from 'next';

const resolveShareLink = vi.fn();
const buildSharedPack = vi.fn();

vi.mock('@/modules/accounting/services/share/shareResolver', () => ({
  resolveShareLink: (...args: unknown[]) => resolveShareLink(...args),
}));
vi.mock('@/modules/accounting/services/share/sharedPackService', () => ({
  buildSharedPack: (...args: unknown[]) => buildSharedPack(...args),
}));

import { getServerSideProps } from '../../../pages/share/[token]';

interface FakeCtx {
  ctx: GetServerSidePropsContext;
  headers: Record<string, string>;
  res: { statusCode: number };
}

function makeCtx(opts: {
  token?: unknown;
  reqHeaders?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
} = {}): FakeCtx {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => { headers[k] = v; },
  };
  const ctx = {
    params: { token: opts.token ?? 'a'.repeat(43) },
    req: {
      headers: opts.reqHeaders ?? {},
      socket: { remoteAddress: opts.remoteAddress ?? '10.0.0.9' },
    },
    res,
  } as unknown as GetServerSidePropsContext;
  return { ctx, headers, res: res as unknown as { statusCode: number } };
}

const okPack = {
  companyName: 'Brightsphere (Pty) Ltd',
  period: { from: '2026-03-01', to: '2026-08-31' },
  pack: { type: 'management', companyName: 'Brightsphere (Pty) Ltd', period: 'x', generatedAt: 'y', sections: [] },
  commentary: [],
  unclassifiedAccounts: null,
};

beforeEach(() => {
  resolveShareLink.mockReset();
  buildSharedPack.mockReset();
});

describe('/share/[token] getServerSideProps', () => {
  it('sets no-store and noindex before resolving, even on a dead link', async () => {
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx, headers } = makeCtx();
    await getServerSideProps(ctx);
    expect(headers['Cache-Control']).toContain('no-store');
    expect(headers['X-Robots-Tag']).toContain('noindex');
  });

  it('answers unknown, expired and revoked identically, with a 404', async () => {
    const results: unknown[] = [];
    for (const status of ['not_found', 'expired', 'revoked'] as const) {
      resolveShareLink.mockResolvedValue({ status });
      const { ctx, res } = makeCtx();
      const out = await getServerSideProps(ctx);
      expect(res.statusCode).toBe(404);
      results.push(out);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual({ props: { state: 'unavailable' } });
  });

  it('answers a rate-limited caller with 429 and its own state', async () => {
    resolveShareLink.mockResolvedValue({ status: 'rate_limited' });
    const { ctx, res } = makeCtx();
    const out = await getServerSideProps(ctx);
    expect(res.statusCode).toBe(429);
    expect(out).toEqual({ props: { state: 'rate_limited' } });
  });

  it('renders the pack built from the RESOLVED link, and never returns the token', async () => {
    const link = { id: 'link-1', companyId: 'company-1', params: { type: 'management', from: '2026-03-01', to: '2026-08-31' } };
    resolveShareLink.mockResolvedValue({ status: 'ok', link });
    buildSharedPack.mockResolvedValue(okPack);
    const token = 'b'.repeat(43);
    const { ctx, res } = makeCtx({ token });
    const out = await getServerSideProps(ctx);
    expect(buildSharedPack).toHaveBeenCalledWith(link);
    expect(res.statusCode).toBe(200);
    expect(out).toEqual({ props: { state: 'ok', data: okPack } });
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it('takes the first x-forwarded-for hop and truncates the user agent', async () => {
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({
      reqHeaders: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'U'.repeat(900) },
    });
    await getServerSideProps(ctx);
    const [, viewCtx] = resolveShareLink.mock.calls[0] as [unknown, { ip: string | null; userAgent: string | null }];
    expect(viewCtx.ip).toBe('203.0.113.7');
    expect(viewCtx.userAgent).toHaveLength(400);
  });

  it('falls back to the socket address when there is no forwarding header', async () => {
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({ remoteAddress: '198.51.100.4' });
    await getServerSideProps(ctx);
    const [, viewCtx] = resolveShareLink.mock.calls[0] as [unknown, { ip: string | null }];
    expect(viewCtx.ip).toBe('198.51.100.4');
  });

  it('hands the resolver the raw token from the route, unvalidated', async () => {
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({ token: ['one', 'two'] });
    await getServerSideProps(ctx);
    expect(resolveShareLink.mock.calls[0]?.[0]).toEqual(['one', 'two']);
  });
});
