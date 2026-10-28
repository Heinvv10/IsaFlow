/**
 * The few members of Playwright's APIRequestContext that loginGolden and the seeder use, over fetch with a cookie jar.
 * Playwright's own request context throws under bun (it cannot parse a relative response url), and the provisioner
 * runs under bun. Only name/value cookies are kept: the app sets session cookies for one host.
 */
export interface FetchResponse { status(): number; text(): Promise<string>; json(): Promise<any> }
interface RequestOptions { data?: unknown; headers?: Record<string, string> }

export class FetchContext {
  private readonly jar = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  private remember(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 1) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '';
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private async send(method: string, path: string, options: RequestOptions = {}): Promise<FetchResponse> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (options.data !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(path, this.baseUrl), {
      method, headers, body: options.data === undefined ? undefined : JSON.stringify(options.data), redirect: 'manual',
    });
    this.remember(res);
    const text = await res.text();
    return { status: () => res.status, text: async () => text, json: async () => JSON.parse(text) };
  }

  get(path: string, options?: RequestOptions): Promise<FetchResponse> { return this.send('GET', path, options); }
  post(path: string, options?: RequestOptions): Promise<FetchResponse> { return this.send('POST', path, options); }
  async storageState(): Promise<{ cookies: Array<{ name: string; value: string }> }> {
    return { cookies: [...this.jar].map(([name, value]) => ({ name, value })) };
  }
}
