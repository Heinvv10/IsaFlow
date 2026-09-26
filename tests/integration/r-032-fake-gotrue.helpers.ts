/**
 * A stand-in for the three GoTrue endpoints the "Login as" route and the
 * completed-session gate call, so the REAL impersonate / end-impersonation /
 * withAuth code runs against the fixture database without a live provider.
 *
 * Shapes follow what this deployment returns: a magic-link session is AAL1 and
 * carries a fresh `session_id`; `/user` answers with the caller's factors (none
 * here — the target has no MFA, which is exactly the case where dropping the
 * proof cookie still leaves a working session).
 */
import { SignJWT, decodeJwt } from 'jose';

export interface FakeGotrue {
  /** The session id `/verify` will put in the next target token it mints. */
  nextSessionId: string;
  /** Every session id `/verify` has minted, in order. */
  minted: string[];
  /** Every non-GoTrue URL something tried to reach (refused) — e.g. SARS or Netcash. */
  outbound?: string[];
  /** Every GoTrue call made, as "METHOD /path?query". */
  gotrueCalls?: string[];
}

export function signSession(sub: string, sessionId: string | undefined, aal: 'aal1' | 'aal2'): Promise<string> {
  const claims: Record<string, unknown> = { role: 'authenticated', aal };
  if (sessionId !== undefined) claims.session_id = sessionId;
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

export function fakeGotrueFetch(targetFor: (email: string) => string, state: FakeGotrue) {
  const base = process.env.GOTRUE_URL!.replace(/\/+$/, '');
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const emails = new Map<string, string>();
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(base)) {
      state.outbound?.push(url);
      throw new Error(`r-032 fake GoTrue: unexpected fetch ${url}`);
    }
    const path = url.slice(base.length);
    state.gotrueCalls?.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/admin/generate_link') {
      const { email } = JSON.parse(String(init?.body)) as { email: string };
      const token = crypto.randomUUID();
      emails.set(token, email);
      return json({ action_link: `${base}/verify?token=${token}&type=magiclink`, hashed_token: token,
        verification_type: 'magiclink' });
    }
    if (path === '/verify') {
      const { token_hash } = JSON.parse(String(init?.body)) as { token_hash: string };
      const email = emails.get(token_hash);
      if (!email) return new Response('{}', { status: 403 });
      const sessionId = state.nextSessionId;
      state.minted.push(sessionId);
      state.nextSessionId = crypto.randomUUID();
      return json({ access_token: await signSession(targetFor(email), sessionId, 'aal1'),
        refresh_token: `refresh-${sessionId}`, expires_in: 3600, token_type: 'bearer' });
    }
    if (path.startsWith('/logout')) return new Response(null, { status: 204 });
    if (path === '/user') {
      const headers = new Headers(init?.headers);
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      return json({ id: decodeJwt(bearer).sub, factors: [] });
    }
    // Any other GoTrue endpoint (MFA factors, /token, admin user updates) is
    // answered as a refusal, so the caller's own error path runs; the call is
    // still recorded above.
    return new Response(JSON.stringify({ msg: `r-032 fake GoTrue: unhandled path ${path}` }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  };
}
