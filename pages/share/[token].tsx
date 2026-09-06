/**
 * Public share page. No login, no cookie, no company in the URL beyond the
 * token. getServerSideProps does all the work so nothing about the link or the
 * company reaches the client bundle except the rendered pack.
 *
 * ACCEPTED RESIDUAL: Next.js serialises the route query into the page's
 * __NEXT_DATA__, so the rendered HTML carries the token. getServerSideProps
 * does not put it there and a dynamic route cannot opt out; only a middleware
 * rewrite onto a fixed path could. Ruled acceptable: the viewer already holds
 * the token in their address bar, the page is no-store and noindex, and no
 * cookie is issued. Do not "fix" this by editing middleware.ts.
 *
 * Unknown, expired, revoked and FAILED are ONE outcome here: the same neutral
 * page, the same 404, the same props. Distinguishing them would make this
 * route an oracle — a caller walking tokens could tell "this link never
 * existed" from "this link was withdrawn", which is a fact about the company
 * that an unauthenticated caller has no business learning. Rate limiting is
 * the one separate answer, because it says nothing about any link and a
 * recipient who refreshed too fast has to be told to wait rather than to give
 * up.
 *
 * Sameness is not only about the response. All three dead outcomes do the same
 * database work — `resolveShareLink` audits an unmatched token as well as a
 * matched dead one (migration 613) — because a difference in cost is a
 * difference a caller can time.
 */
import type { GetServerSideProps, NextApiRequest } from 'next';
import Head from 'next/head';
import { commitShareView, resolveShareLink } from '@/modules/accounting/services/share/shareResolver';
import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { stripOmittedSections } from '@/modules/accounting/services/share/sharedSections';
import { SharedPackView, type SharedPackProps } from '@/components/accounting/share/SharedPackView';
import { getClientIp } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

type PageProps =
  | { state: 'ok'; data: SharedPackProps }
  | { state: 'unavailable' | 'rate_limited' };

const MESSAGES: Record<'unavailable' | 'rate_limited', string> = {
  unavailable: 'This link is not available. Ask the sender for a new one.',
  rate_limited: 'Too many requests. Try again in a few minutes.',
};

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

/** The platform's one IP extractor (pentest H8): it takes the LAST hop of
 *  x-forwarded-for, appended by the closest trusted proxy, not the first, which
 *  the client sends and can therefore forge. This page had its own copy taking
 *  the first hop, which handed an unauthenticated caller a free per-IP rate
 *  bucket per fabricated header and a fabricated address in the audit trail.
 *
 *  `getClientIp` answers the string 'unknown' when it has nothing; the audit
 *  column takes NULL for that rather than a literal that reads like an address.
 */
function clientIp(req: NextApiRequest): string | null {
  const ip = getClientIp(req);
  return ip === 'unknown' ? null : ip;
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // Set on every outcome, before anything is resolved: a crawler that ignores
  // the meta tag still sees the header, and a shared pack must never sit in a
  // proxy cache keyed on a URL that carries its own credential.
  ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  ctx.res.setHeader('Cache-Control', 'no-store, private');

  const ua = ctx.req.headers['user-agent'];
  const viewCtx = {
    ip: clientIp(ctx.req as unknown as NextApiRequest),
    // Raw. `recordShareView` is the only function that writes user_agent and
    // it clips to 512 there, so the bound lives once, next to the column it
    // protects. A second, shorter cap here made the effective limit whichever
    // call site a reader happened to look at.
    userAgent: typeof ua === 'string' ? ua : null,
  };
  // Everything from here down is inside ONE try. `resolveShareLink` used to sit
  // outside it, so a throw from the lookup, the rate limiter or the audit write
  // produced Next's 500 page — which told a caller walking tokens that this one
  // had reached the database, exactly the distinction the neutral 404 exists to
  // refuse. A failure is now the same unavailable page as a dead link.
  //
  // `audited` carries the link identity out of the resolve for the log line
  // below; there is nothing to name if the throw happened before it was known.
  let audited: { id: string; companyId: string } | null = null;
  try {
    const resolution = await resolveShareLink(ctx.params?.token, viewCtx);

    if (resolution.status === 'rate_limited') {
      ctx.res.statusCode = 429;
      return { props: { state: 'rate_limited' } };
    }
    if (resolution.status !== 'ok') {
      ctx.res.statusCode = 404;
      return { props: { state: 'unavailable' } };
    }

    const { id, companyId } = resolution.link;
    audited = { id, companyId };

    // Only what the view draws crosses into the props. The builder also returns
    // `unclassifiedAccounts` — how many of the company's accounts have no
    // recognised subtype and the rand value sitting in them — which is an
    // internal bookkeeping-quality confession, is not derivable from anything on
    // the page, and would otherwise sit in the HTML of a document sent to a bank.
    const built = await buildSharedPack(resolution.link);
    const data: SharedPackProps = {
      companyName: built.companyName,
      period: built.period,
      pack: stripOmittedSections(built.pack),
      commentary: built.commentary,
    };

    // AFTER the build. A view recorded before it would leave share_link_views
    // claiming a successful view the recipient never saw. A throw from here is
    // a refusal to serve: the pack is not shown unaudited.
    await commitShareView({ id, companyId }, viewCtx);

    // JSON round-trip: getServerSideProps rejects `undefined` anywhere in the
    // tree, and a stripped section has no `data` key at all.
    return { props: { state: 'ok', data: JSON.parse(JSON.stringify(data)) as SharedPackProps } };
  } catch (err) {
    // Degrade to the SAME neutral page a dead link gets. Anything else — Next's
    // 500 page — would tell a caller walking tokens that this one is live.
    log.error('Share link view failed', {
      companyId: audited?.companyId ?? null, shareLinkId: audited?.id ?? null,
      err: err instanceof Error ? err.message : String(err),
    }, 'share');
    ctx.res.statusCode = 404;
    return { props: { state: 'unavailable' } };
  }
};
