/**
 * /oauth/authorize — OAuth 2.0 consent screen (PRD-10 Layer 2).
 *
 * Server-renders the trust frame: app logo, name, verified badge, scopes,
 * company selector. On Authorise → POST /api/oauth/consent → redirects to
 * the partner's redirect_uri with `?code=...&state=...`. On Cancel → redirects
 * back with `?error=access_denied&state=...`.
 *
 * Full-bleed, no AppLayout chrome — this is a "trust frame" page, distinct
 * from the rest of the app so users can recognise it as a consent surface.
 */
import { useState, type FormEvent } from 'react';
import Image from 'next/image';
import type { GetServerSideProps } from 'next';
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { getOauthAppByClientId, OAUTH_SCOPES } from '@/lib/auth/oauth';
import { ConsentScopeList } from '@/components/oauth/ConsentScopeList';
import { ConsentCompanyPicker } from '@/components/oauth/ConsentCompanyPicker';
import { ConsentRejected } from '@/components/oauth/ConsentRejected';
import { partitionRequestedScopes } from '@/lib/auth/consentScopes';
import { apiFetch } from '@/lib/apiFetch';
import { parseCookies, ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from '@/lib/auth/cookies';
import { resolveConsentCompany, type ConsentCompany } from '@/lib/auth/consentCompany';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { verifyToken } from '@/lib/auth/gotrue';

interface ConsentApp {
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  isVerified: boolean;
}

interface Props {
  ok: true;
  app: ConsentApp;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** Memberships this user may grant against — resolved server-side. */
  companies: ConsentCompany[];
  /** Pre-selected company (active company when it is a membership). */
  selectedCompanyId: string;
}

interface ErrorProps {
  ok: false;
  error: string;
}


export default function AuthorizePage(props: Props | ErrorProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opt-in checkbox state (write:post). Declared before the early return so
  // hook order stays stable regardless of the error/ok branch.
  const [optInChecked, setOptInChecked] = useState<Record<string, boolean>>({});
  // Which company this grant gets pinned to. Same rule as above: declared
  // before the early return so hook order is stable across both branches.
  const [companyId, setCompanyId] = useState(props.ok ? props.selectedCompanyId : '');

  if (!props.ok) return <ConsentRejected error={props.error} />;

  const { app, clientId, redirectUri, scopes, state, codeChallenge, codeChallengeMethod, companies } = props;

  // Posting scopes (write:post) are opt-in: shown UNCHECKED even when the
  // client requested them, and granted only if the user actively ticks them.
  const { autoGranted, optIn } = partitionRequestedScopes(scopes);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Submit the full requested set + the explicitly-ticked opt-in scopes.
      // The server (consent.ts) re-derives the grant — it will NOT grant an
      // opt-in scope (write:post) unless it is confirmed here.
      const optInConfirmed = optIn.filter((s) => optInChecked[s]);
      const res = await apiFetch('/api/oauth/consent', {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          redirectUri,
          scopes,
          optInConfirmed,
          state,
          codeChallenge,
          codeChallengeMethod,
          // Pin the grant to the company chosen here. consent.ts re-checks
          // membership on this value — the picker is UX, not the boundary.
          companyId,
        }),
      });
      const json = (await res.json()) as { data?: { redirectTo: string }; error?: { message: string } };
      if (!res.ok || !json.data?.redirectTo) {
        setError(json.error?.message ?? 'Authorisation failed');
        return;
      }
      // Hard navigation to the partner — leaves the ISAFlow domain.
      window.location.href = json.data.redirectTo;
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = () => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (state) url.searchParams.set('state', state);
    window.location.href = url.toString();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
      <div className="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-gradient-to-b from-slate-800/80 to-slate-900 p-6 border-b border-slate-800">
          <div className="flex items-start gap-4">
            {app.logoUrl ? (
              <div className="relative h-16 w-16 rounded-xl overflow-hidden ring-1 ring-slate-700 bg-slate-800 shrink-0">
                <Image src={app.logoUrl} alt={app.name} fill sizes="64px" />
              </div>
            ) : (
              <div className="h-16 w-16 rounded-xl bg-slate-800 ring-1 ring-slate-700 shrink-0 flex items-center justify-center text-xl font-semibold text-slate-400">
                {app.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <h1 className="text-xl font-semibold flex items-center gap-2">
                {app.name}
                {app.isVerified && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-teal-900/60 text-teal-300 border border-teal-800/60 flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" /> Verified
                  </span>
                )}
              </h1>
              <p className="text-sm text-slate-400 mt-1">would like to access your ISAFlow account.</p>
              {app.homepageUrl && (
                <a
                  href={app.homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-teal-400 hover:text-teal-300 mt-1 inline-block"
                >
                  {app.homepageUrl}
                </a>
              )}
            </div>
          </div>
          {app.description && (
            <p className="text-sm text-slate-300 mt-4 leading-relaxed">{app.description}</p>
          )}
        </div>

        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <ConsentCompanyPicker
            companies={companies}
            value={companyId}
            onChange={setCompanyId}
            disabled={submitting}
            appName={app.name}
          />

          <div>
            <ConsentScopeList
              autoGranted={autoGranted}
              optIn={optIn}
              optInChecked={optInChecked}
              onToggle={(s, checked) => setOptInChecked((prev) => ({ ...prev, [s]: checked }))}
            />
          </div>

          {!app.isVerified && (
            <div className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>This app has not been verified by ISAFlow. Authorise only if you trust the developer.</span>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-teal-700 hover:bg-teal-600 text-white disabled:opacity-50 transition flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Authorise
            </button>
          </div>
        </form>

        <div className="px-6 py-3 bg-slate-950/50 border-t border-slate-800 text-xs text-slate-500">
          You can revoke this access at any time from{' '}
          <a href="/accounting/settings/connected-apps" className="text-teal-400 hover:text-teal-300">
            Settings → Connected Apps
          </a>.
        </div>
      </div>
    </div>
  );
}

const VALID_SCOPES = new Set<string>(OAUTH_SCOPES);

export const getServerSideProps: GetServerSideProps<Props | ErrorProps> = async (ctx) => {
  // Auth gate — if the user has no valid session cookie, bounce to /login
  // with a returnTo so they come straight back here after signing in.
  const cookies = parseCookies(ctx.req as unknown as Parameters<typeof parseCookies>[0]);
  const accessToken = cookies[ACCESS_COOKIE];
  let userId = '';
  if (accessToken) {
    try {
      const claims = await verifyToken(accessToken);
      userId = claims.sub;
    } catch { /* fall through to login redirect */ }
  }
  if (!userId) {
    const url = ctx.resolvedUrl ?? '/oauth/authorize';
    return { redirect: { destination: `/login?returnTo=${encodeURIComponent(url)}`, permanent: false } };
  }

  const q = ctx.query;
  const clientId = typeof q.client_id === 'string' ? q.client_id : '';
  const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
  const scopeStr = typeof q.scope === 'string' ? q.scope : '';
  const state = typeof q.state === 'string' ? q.state : '';
  const codeChallenge = typeof q.code_challenge === 'string' ? q.code_challenge : '';
  const codeChallengeMethod = typeof q.code_challenge_method === 'string' ? q.code_challenge_method : 'S256';
  const responseType = typeof q.response_type === 'string' ? q.response_type : '';

  if (!clientId) return { props: { ok: false, error: 'Missing client_id' } };
  if (!redirectUri) return { props: { ok: false, error: 'Missing redirect_uri' } };
  if (responseType !== 'code') return { props: { ok: false, error: 'Only response_type=code is supported' } };
  if (!codeChallenge) return { props: { ok: false, error: 'Missing PKCE code_challenge (PKCE is mandatory)' } };
  if (codeChallengeMethod !== 'S256') return { props: { ok: false, error: 'Only S256 PKCE is supported' } };

  const app = await getOauthAppByClientId(clientId);
  if (!app) return { props: { ok: false, error: 'Unknown OAuth client' } };
  if (!app.redirectUris.includes(redirectUri)) {
    return { props: { ok: false, error: 'redirect_uri is not registered for this app' } };
  }

  const scopes = scopeStr.split(/[\s,]+/).filter(Boolean);
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) return { props: { ok: false, error: `Unknown scope: ${s}` } };
  }
  if (scopes.length === 0) return { props: { ok: false, error: 'At least one scope must be requested' } };

  // The grant is pinned to ONE company for the life of the token, so the user
  // has to see (and for a multi-company user, choose) which one. Options come
  // from real memberships; consent.ts re-checks the submitted value anyway.
  const memberships = await getUserCompanies(userId);
  const choice = resolveConsentCompany(memberships, cookies[ACTIVE_COMPANY_COOKIE]);
  if (!choice) {
    return { props: { ok: false, error: 'Your account is not linked to a company, so there is nothing to authorise.' } };
  }

  return {
    props: {
      ok: true,
      companies: choice.companies,
      selectedCompanyId: choice.selectedCompanyId,
      app: {
        name: app.name,
        description: app.description,
        logoUrl: app.logoUrl,
        homepageUrl: app.homepageUrl,
        isVerified: app.isVerified,
      },
      clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
    },
  };
};
