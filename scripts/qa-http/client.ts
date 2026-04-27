import { CookieJar } from '../_qa';

export type HttpResponse = { status: number; body: unknown; setCookies: string[] };

/**
 * Tiny HTTP client: cookie jar + auto-CSRF header injection.
 * Mirrors the way the IsaFlow UI clients carry cookies into API calls.
 */
export class HttpClient {
  readonly jar = new CookieJar();
  constructor(private readonly baseUrl: string) {}

  async request(method: string, url: string, body?: unknown): Promise<HttpResponse> {
    const headers: Record<string, string> = { Cookie: this.jar.header() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const csrf = this.jar.get('isaflow_csrf');
    if (csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(`${this.baseUrl}${url}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    const setCookies: string[] = [];
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === 'function') {
      setCookies.push(...anyHeaders.getSetCookie());
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) setCookies.push(sc);
    }
    this.jar.ingest(setCookies);

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch (_err) {
      // Non-JSON response (e.g. HTML redirect page) — keep raw text.
      // No log: the caller decides whether non-JSON is unexpected for the endpoint.
    }

    return { status: res.status, body: parsed, setCookies };
  }
}

/**
 * Authenticate, seed CSRF, switch active company.
 *
 * Workaround: middleware bypasses /api/* routes for CSRF issuance, and
 * /accounting redirects to /onboarding (no CSRF on redirect). We seed
 * `ff_onboarding_done=1` via the public CookieJar.set so the GET passes
 * through and middleware issues the CSRF cookie.
 */
export async function authAndSwitchCompany(
  client: HttpClient, email: string, password: string, companyId: string,
): Promise<void> {
  console.log(`[auth] base=${client['baseUrl']} as=${email}`);

  const login = await client.request('POST', '/api/auth/login', { email, password });
  if (login.status !== 200) {
    console.error(`[auth] login failed: HTTP ${login.status}`, login.body);
    process.exit(1);
  }
  console.log('[auth] login OK');

  client.jar.set('ff_onboarding_done', '1');
  await client.request('GET', '/accounting');
  if (!client.jar.get('isaflow_csrf')) {
    console.error('[auth] no CSRF cookie issued — middleware did not run');
    process.exit(1);
  }
  console.log('[auth] CSRF cookie present');

  const switchRes = await client.request('POST', '/api/auth/switch-company', { companyId });
  if (switchRes.status !== 200) {
    console.error(`[auth] switch-company failed: HTTP ${switchRes.status}`, switchRes.body);
    process.exit(1);
  }
  console.log(`[auth] switched to ${companyId}`);
}
