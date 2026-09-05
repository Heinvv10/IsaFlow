/**
 * Public share page. No login, no cookie, no company in the URL beyond the
 * token. getServerSideProps does all the work so nothing about the link or the
 * company reaches the client bundle except the rendered pack.
 *
 * Unknown, expired and revoked are ONE outcome here: the same neutral page,
 * the same 404, the same props. Distinguishing them would make this route an
 * oracle — a caller walking tokens could tell "this link never existed" from
 * "this link was withdrawn", which is a fact about the company that an
 * unauthenticated caller has no business learning. Rate limiting is the one
 * separate answer, because it says nothing about any link and a recipient who
 * refreshed too fast has to be told to wait rather than to give up.
 */
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { buildSharedPack, type SharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { SharedPackView } from '@/components/accounting/share/SharedPackView';

type PageProps =
  | { state: 'ok'; data: SharedPack }
  | { state: 'unavailable' | 'rate_limited' };

const MESSAGES: Record<'unavailable' | 'rate_limited', string> = {
  unavailable: 'This link is not available. Ask the sender for a new one.',
  rate_limited: 'Too many requests. Try again in a few minutes.',
};

const UA_MAX_CHARS = 400;

export default function SharePage(props: PageProps) {
  if (props.state !== 'ok') {
    return (
      <>
        <Head><title>Link unavailable</title><meta name="robots" content="noindex,nofollow" /></Head>
        <main className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="text-lg font-medium text-[var(--ff-text-primary)]">Link unavailable</h1>
          <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">{MESSAGES[props.state]}</p>
        </main>
      </>
    );
  }
  return (
    <>
      <Head>
        <title>{`${props.data.companyName} — ${props.data.pack.type} pack`}</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <SharedPackView data={props.data} />
    </>
  );
}

interface IpSource {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
}

/** First hop of x-forwarded-for, else the socket. The resolver clips the value
 *  before it reaches the audit table; this only picks it. */
function clientIp(req: IpSource): string | null {
  const xf = req.headers['x-forwarded-for'];
  const raw = typeof xf === 'string' ? xf : Array.isArray(xf) ? xf[0] : undefined;
  const first = raw?.split(',')[0]?.trim();
  if (first) return first;
  return req.socket.remoteAddress ?? null;
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // Set on every outcome, before anything is resolved: a crawler that ignores
  // the meta tag still sees the header, and a shared pack must never sit in a
  // proxy cache keyed on a URL that carries its own credential.
  ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  ctx.res.setHeader('Cache-Control', 'no-store, private');

  const ua = ctx.req.headers['user-agent'];
  const resolution = await resolveShareLink(ctx.params?.token, {
    ip: clientIp(ctx.req as unknown as IpSource),
    userAgent: typeof ua === 'string' ? ua.slice(0, UA_MAX_CHARS) : null,
  });

  if (resolution.status === 'rate_limited') {
    ctx.res.statusCode = 429;
    return { props: { state: 'rate_limited' } };
  }
  if (resolution.status !== 'ok') {
    ctx.res.statusCode = 404;
    return { props: { state: 'unavailable' } };
  }

  // JSON round-trip: getServerSideProps rejects `undefined` anywhere in the
  // tree, and the pack's optional figures are absent rather than null.
  const data = JSON.parse(JSON.stringify(await buildSharedPack(resolution.link))) as SharedPack;
  return { props: { state: 'ok', data } };
};
