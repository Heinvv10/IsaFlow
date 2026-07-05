/**
 * HTTP-only helper for golden-paths specs (A–Z programme, Phase 0).
 *
 * Wraps Playwright's APIRequestContext with:
 *   - login via POST /api/auth/login (cookie jar keeps the GoTrue session)
 *   - CSRF double-submit: mirrors the isaflow_csrf cookie into x-csrf-token
 *   - apiResponse envelope unwrapping ({success,data} | {success:false,error})
 *
 * HTTP-only on purpose: the same specs must run against the workspace dev
 * server, CI, and prod Demo post-deploy, where direct DB access is not
 * available. All state assertions go through the public API.
 */
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { existsSync } from 'fs';
import { getE2ECredentials } from '../_creds';
import { GOLDEN_STATE_FILE } from './_global-setup';

const CSRF_COOKIE = 'isaflow_csrf';
const CSRF_HEADER = 'x-csrf-token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
    this.name = 'ApiError';
  }
}

export class Api {
  private constructor(
    public readonly ctx: APIRequestContext,
    private csrf: string,
  ) {}

  /**
   * Reuses the session captured by _global-setup (one login per suite run —
   * the login endpoint allows only 10 attempts per email per 15 min). Falls
   * back to a fresh login when the state file is absent (single-spec runs
   * outside the golden config).
   */
  static async login(baseURL: string): Promise<Api> {
    if (existsSync(GOLDEN_STATE_FILE)) {
      const ctx = await pwRequest.newContext({ baseURL, storageState: GOLDEN_STATE_FILE });
      const csrf = await Api.readCsrf(ctx);
      if (csrf) return new Api(ctx, csrf);
      await ctx.dispose();
    }

    const { email, password } = getE2ECredentials();
    const ctx = await pwRequest.newContext({ baseURL });
    const res = await ctx.post('/api/auth/login', { data: { email, password } });
    if (res.status() !== 200) {
      throw new Error(`login failed: ${res.status()} ${await res.text()}`);
    }
    let csrf = await Api.readCsrf(ctx);
    if (!csrf) {
      // middleware issues the cookie on any routed request
      await ctx.get('/accounting');
      csrf = await Api.readCsrf(ctx);
    }
    if (!csrf) throw new Error('no isaflow_csrf cookie after login');
    return new Api(ctx, csrf);
  }

  private static async readCsrf(ctx: APIRequestContext): Promise<string> {
    const state = await ctx.storageState();
    return state.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? '';
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }

  /** GET returning the unwrapped `data`; throws ApiError on non-2xx/!success. */
  async get<T = any>(path: string): Promise<T> {
    return this.unwrap('GET', path, await this.ctx.get(path));
  }

  /** POST returning the unwrapped `data`; throws ApiError on non-2xx/!success. */
  async post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.unwrap(
      'POST',
      path,
      await this.ctx.post(path, { data: body, headers: { [CSRF_HEADER]: this.csrf } }),
    );
  }

  /** PUT returning the unwrapped `data`; throws ApiError on non-2xx/!success. */
  async put<T = any>(path: string, body?: unknown): Promise<T> {
    return this.unwrap(
      'PUT',
      path,
      await this.ctx.put(path, { data: body, headers: { [CSRF_HEADER]: this.csrf } }),
    );
  }

  /** DELETE returning the unwrapped `data`; throws ApiError on non-2xx/!success. */
  async del<T = any>(path: string, body?: unknown): Promise<T> {
    return this.unwrap(
      'DELETE',
      path,
      await this.ctx.delete(path, { data: body, headers: { [CSRF_HEADER]: this.csrf } }),
    );
  }

  /** Raw POST — no envelope unwrapping, never throws. For asserting failures. */
  async postRaw(path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.ctx.post(path, {
      data: body,
      headers: { [CSRF_HEADER]: this.csrf },
    });
    return { status: res.status(), json: await res.json().catch(() => null) };
  }

  /** Raw GET — no envelope unwrapping, never throws. */
  async getRaw(path: string): Promise<{ status: number; json: any; text: string }> {
    const res = await this.ctx.get(path);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body (e.g. PDF) — callers use `text`/status
    }
    return { status: res.status(), json, text };
  }

  /** GET expecting a binary body (PDF etc.) — returns status + content-type + byte length. */
  async getBinary(path: string): Promise<{ status: number; contentType: string; bytes: number }> {
    const res = await this.ctx.get(path);
    const buf = await res.body();
    return {
      status: res.status(),
      contentType: res.headers()['content-type'] ?? '',
      bytes: buf.length,
    };
  }

  private async unwrap<T>(
    method: string,
    path: string,
    res: Awaited<ReturnType<APIRequestContext['get']>>,
  ): Promise<T> {
    const status = res.status();
    const body = await res.json().catch(async () => ({ nonJson: await res.text() }));
    if (status < 200 || status >= 300 || body?.success === false) {
      throw new ApiError(status, body, method, path);
    }
    // apiResponse.success wraps payloads as {success:true, data}
    return (body?.data ?? body) as T;
  }
}

/** Unique per-run reference so specs can identify and clean their records. */
export function gpRef(tag: string): string {
  return `GP-${tag}-${Date.now().toString(36)}`;
}

/** Today as YYYY-MM-DD (server-local date is fine for spec inputs). */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
