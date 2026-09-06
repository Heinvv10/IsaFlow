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
const commitShareView = vi.fn();
const logError = vi.fn();
/** Call order across the two mocks, so "audited only after it built" is a
 *  sequence assertion rather than two independent call counts. */
const order: string[] = [];

vi.mock('@/modules/accounting/services/share/shareResolver', () => ({
  resolveShareLink: (...args: unknown[]) => resolveShareLink(...args),
  commitShareView: (...args: unknown[]) => { order.push('commit'); return commitShareView(...args); },
}));
vi.mock('@/lib/logger', () => ({ log: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/modules/accounting/services/share/sharedPackService', () => ({
  buildSharedPack: (...args: unknown[]) => { order.push('build'); return buildSharedPack(...args); },
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

const LINK = {
  id: 'link-1',
  companyId: 'company-1',
  params: { type: 'management', from: '2026-03-01', to: '2026-08-31' },
};

/** What the builder returns — including the two things the page must not pass
 *  on: the data of the omitted sections, and unclassifiedAccounts. */
const okPack = {
  companyName: 'Brightsphere (Pty) Ltd',
  period: { from: '2026-03-01', to: '2026-08-31' },
  pack: {
    type: 'management',
    companyName: 'Brightsphere (Pty) Ltd',
    period: 'x',
    generatedAt: 'y',
    sections: [
      { type: 'income_statement', title: 'Income Statement', data: { revenue: 5_000_000 } },
      { type: 'ratios', title: 'Financial Ratios', data: { currentRatio: -0.58, ebitda: -1_819_000 } },
      { type: 'kpis', title: 'KPI Scorecard', data: { scorecard: [{ name: 'Gross margin' }] } },
      { type: 'waterfall', title: 'Profit Waterfall', data: { steps: [{ label: 'Revenue' }] } },
      { type: 'trends', title: 'Trend Analysis', data: { series: [1, 2, 3] } },
      { type: 'commentary', title: 'Commentary', data: { summary: 'Generated summary nobody approved.' } },
    ],
  },
  commentary: [{ sectionRef: 'income_statement', rowRef: 'netProfit', text: 'Approved note.' }],
  unclassifiedAccounts: {
    accounts: 13,
    amount: 117_139_882.5,
    message: 'Set account_subtype on them for accurate figures.',
    byType: [{ accountType: 'asset', accounts: 4 }],
  },
};

beforeEach(() => {
  resolveShareLink.mockReset();
  buildSharedPack.mockReset();
  commitShareView.mockReset();
  logError.mockReset();
  commitShareView.mockResolvedValue('served');
  order.length = 0;
});

/** Resolve to a live link and build the fixture pack. */
function liveLink(): void {
  resolveShareLink.mockResolvedValue({ status: 'ok', link: LINK });
  buildSharedPack.mockResolvedValue(okPack);
}

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

  it('degrades to the SAME neutral 404 when the resolver itself throws', async () => {
    // The resolve used to sit outside the try. A throw from the lookup, the
    // rate limiter or the audit write therefore produced Next's 500 page,
    // which told a caller walking tokens that this one had reached the
    // database — the exact distinction the neutral 404 refuses to state.
    resolveShareLink.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const { ctx, res, headers } = makeCtx();

    const out = await getServerSideProps(ctx);

    expect(out).toEqual({ props: { state: 'unavailable' } });
    expect(res.statusCode).toBe(404);
    expect(headers['Cache-Control']).toBe('no-store, private');
    expect(buildSharedPack).not.toHaveBeenCalled();
  });

  it('logs a resolver failure without a link identity it never learned, and without the token', async () => {
    resolveShareLink.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const { ctx } = makeCtx({ token: 'z'.repeat(43) });

    await getServerSideProps(ctx);

    expect(logError).toHaveBeenCalledTimes(1);
    const [, meta] = logError.mock.calls[0]!;
    expect(meta).toMatchObject({ companyId: null, shareLinkId: null });
    expect(JSON.stringify(logError.mock.calls[0])).not.toContain('z'.repeat(43));
  });

  it('answers a rate-limited caller with 429 and its own state', async () => {
    resolveShareLink.mockResolvedValue({ status: 'rate_limited' });
    const { ctx, res } = makeCtx();
    const out = await getServerSideProps(ctx);
    expect(res.statusCode).toBe(429);
    expect(out).toEqual({ props: { state: 'rate_limited' } });
  });

  it('renders the pack built from the RESOLVED link, and never returns the token', async () => {
    liveLink();
    const token = 'b'.repeat(43);
    const { ctx, res } = makeCtx({ token });
    const out = await getServerSideProps(ctx);
    expect(buildSharedPack).toHaveBeenCalledWith(LINK);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it('passes on ONLY the four fields the view draws', async () => {
    liveLink();
    const out = await getServerSideProps(makeCtx().ctx) as { props: { state: string; data: Record<string, unknown> } };
    expect(Object.keys(out.props).sort()).toEqual(['data', 'state']);
    expect(Object.keys(out.props.data).sort()).toEqual(['commentary', 'companyName', 'pack', 'period']);
  });

  it('never ships unclassifiedAccounts to the recipient', async () => {
    liveLink();
    const out = await getServerSideProps(makeCtx().ctx);
    const json = JSON.stringify(out);
    // The count, the rand value, the remedy sentence: an internal
    // bookkeeping-quality confession on a document sent to a bank.
    expect(json).not.toContain('unclassifiedAccounts');
    expect(json).not.toContain('Set account_subtype');
    expect(json).not.toContain('117139882.5');
  });

  it('strips the data of every section a shared link does not draw', async () => {
    liveLink();
    const out = await getServerSideProps(makeCtx().ctx) as
      { props: { data: { pack: { sections: Array<{ type: string; title: string; data?: unknown }> } } } };
    const byType = Object.fromEntries(out.props.data.pack.sections.map(sec => [sec.type, sec]));

    for (const t of ['ratios', 'kpis', 'waterfall', 'trends', 'commentary']) {
      expect(byType[t]).toBeDefined();
      expect(byType[t]!.title).toBeTruthy();
      expect('data' in byType[t]!).toBe(false);
    }
    // The sections that ARE drawn keep their figures.
    expect(byType.income_statement!.data).toEqual({ revenue: 5_000_000 });

    const json = JSON.stringify(out);
    expect(json).not.toContain('Generated summary nobody approved.');
    expect(json).not.toContain('currentRatio');
    expect(json).not.toContain('scorecard');
  });

  it('records the view only AFTER the pack is built', async () => {
    liveLink();
    await getServerSideProps(makeCtx().ctx);
    expect(order).toEqual(['build', 'commit']);
    expect(commitShareView).toHaveBeenCalledWith({ id: LINK.id, companyId: LINK.companyId }, expect.anything());
  });

  it('records NO view when the pack fails to build, and degrades to the neutral 404', async () => {
    resolveShareLink.mockResolvedValue({ status: 'ok', link: LINK });
    buildSharedPack.mockRejectedValue(new Error('figures query timed out'));
    const { ctx, res } = makeCtx();
    const out = await getServerSideProps(ctx);

    expect(commitShareView).not.toHaveBeenCalled();
    expect(order).toEqual(['build']);
    // Byte-identical to a dead link: a 500 here would tell a caller walking
    // tokens that this one is live.
    expect(res.statusCode).toBe(404);
    expect(out).toEqual({ props: { state: 'unavailable' } });
  });

  it('serves the neutral page, not the pack, when the link is withdrawn mid-build', async () => {
    // The build reads the whole ledger twice; a sender revoking during it is
    // exactly when they most mean it. commitShareView re-checks liveness in
    // its own UPDATE and answers 'withdrawn' — the pack already in hand is
    // stale and must be thrown away, not rendered.
    resolveShareLink.mockResolvedValue({ status: 'ok', link: LINK });
    buildSharedPack.mockResolvedValue(okPack);
    commitShareView.mockResolvedValue('withdrawn');
    const { ctx, res } = makeCtx();

    const out = await getServerSideProps(ctx);

    expect(out).toEqual({ props: { state: 'unavailable' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(out)).not.toContain('Brightsphere');
  });

  it('degrades the same way when the audit write fails', async () => {
    liveLink();
    commitShareView.mockRejectedValue(new Error('share_link_views insert failed'));
    const { ctx, res } = makeCtx();
    expect(await getServerSideProps(ctx)).toEqual({ props: { state: 'unavailable' } });
    expect(res.statusCode).toBe(404);
  });

  it('logs the failure with the link identity and no token', async () => {
    resolveShareLink.mockResolvedValue({ status: 'ok', link: LINK });
    buildSharedPack.mockRejectedValue(new Error('figures query timed out'));
    const token = 'c'.repeat(43);
    await getServerSideProps(makeCtx({ token }).ctx);

    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ companyId: 'company-1', shareLinkId: 'link-1', err: 'figures query timed out' }),
      'share',
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain(token);
  });

  it('takes the LAST x-forwarded-for hop, not the client-supplied first', async () => {
    // pentest H8. The first entry is whatever the caller wrote in the header;
    // the last is appended by the closest trusted proxy. Taking the first hands
    // an unauthenticated caller a fresh per-IP rate bucket per fabricated
    // value, and writes that fabrication into share_link_views.
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({
      reqHeaders: { 'x-forwarded-for': '1.1.1.1, 10.0.0.5', 'user-agent': 'U'.repeat(900) },
    });
    await getServerSideProps(ctx);
    const [, viewCtx] = resolveShareLink.mock.calls[0] as [unknown, { ip: string | null; userAgent: string | null }];
    expect(viewCtx.ip).toBe('10.0.0.5');
    // Handed on RAW: the only bound is in recordShareView, next to the TEXT
    // column it protects (512, pinned in shareResolver.test.ts). Two caps meant
    // the real limit was whichever call site you read.
    expect(viewCtx.userAgent).toHaveLength(900);
  });

  it('takes the last header when the proxy sent x-forwarded-for more than once', async () => {
    // Node hands a repeated header through as an array; the last element is
    // the one the closest proxy appended.
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({ reqHeaders: { 'x-forwarded-for': ['1.1.1.1', '203.0.113.7, 10.0.0.5'] } });
    await getServerSideProps(ctx);
    const [, viewCtx] = resolveShareLink.mock.calls[0] as [unknown, { ip: string | null }];
    expect(viewCtx.ip).toBe('10.0.0.5');
  });

  it('records NULL rather than the literal "unknown" when there is no address', async () => {
    resolveShareLink.mockResolvedValue({ status: 'not_found' });
    const { ctx } = makeCtx({ remoteAddress: '' });
    await getServerSideProps(ctx);
    const [, viewCtx] = resolveShareLink.mock.calls[0] as [unknown, { ip: string | null }];
    expect(viewCtx.ip).toBeNull();
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
