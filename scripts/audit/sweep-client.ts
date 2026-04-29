/**
 * HTTP client with cookie jar for the API contract sweep.
 * scripts/audit/sweep-client.ts
 */

export interface SweepResponse {
  status: number;
  body: unknown;
  latencyMs: number;
  rawText: string;
}

class CookieJar {
  private cookies = new Map<string, string>();

  ingest(setCookieHeaders: string[]): void {
    for (const sc of setCookieHeaders) {
      const [pair] = sc.split(';', 1);
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export class SweepClient {
  public readonly jar = new CookieJar();

  constructor(public readonly baseUrl: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<SweepResponse> {
    const headers: Record<string, string> = {
      Cookie: this.jar.header(),
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const csrf = this.jar.get('isaflow_csrf');
    if (csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      headers['X-CSRF-Token'] = csrf;
    }

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        status: 0,
        body: null,
        latencyMs: Date.now() - t0,
        rawText: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const latencyMs = Date.now() - t0;
    const setCookies: string[] = [];
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    if (typeof anyHeaders.getSetCookie === 'function') {
      setCookies.push(...anyHeaders.getSetCookie());
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) setCookies.push(sc);
    }
    this.jar.ingest(setCookies);

    const rawText = await res.text().catch(() => '');
    let parsed: unknown = rawText;
    try { parsed = JSON.parse(rawText); } catch { /* keep raw */ }

    return { status: res.status, body: parsed, latencyMs, rawText };
  }
}

/**
 * Authenticate and switch to a given company.
 * Returns false if authentication fails.
 */
export async function authenticate(
  client: SweepClient,
  email: string,
  password: string,
  companyId: string,
): Promise<boolean> {
  const loginRes = await client.request('POST', '/api/auth/login', { email, password });
  if (loginRes.status !== 200) {
    process.stderr.write(`[auth] login failed: HTTP ${loginRes.status}\n`);
    return false;
  }

  // Trigger CSRF cookie
  client.jar.set('ff_onboarding_done', '1');
  await client.request('GET', '/accounting');

  // Switch company
  const switchRes = await client.request('POST', '/api/auth/switch-company', { companyId });
  if (switchRes.status !== 200) {
    process.stderr.write(`[auth] switch-company failed: HTTP ${switchRes.status}\n`);
    return false;
  }

  return true;
}
