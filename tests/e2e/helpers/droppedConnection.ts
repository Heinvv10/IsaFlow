/**
 * Re-issue an idempotent API call the dev server dropped.
 *
 * The hosted Golden lane runs against `next dev`, which drops sockets while it compiles a route or closes an idle
 * keep-alive connection the client is about to reuse; Playwright's APIRequestContext then rejects with
 * `read ECONNRESET` (#1110: `GET .../components` right after a long UI step, and `POST /api/auth/switch-company`
 * in a beforeEach). The request never reached a handler, so for a GET or an idempotent POST sending it again is the
 * same as sending it once. Only a dropped connection is retried, and only until the budget is spent; any other error
 * and any HTTP status goes straight to the caller, so a real failure still fails the test.
 *
 * Dev and CI localhost only. Against any other host (playwright-prod.config.ts runs tests/e2e at app.isaflow.co.za) a
 * reset is an outage signal, so the call runs once and fails as before. Every re-send is logged on stderr and added to
 * the test's annotations (test, error code, attempt), so a rising rate stays visible.
 */

import { test } from '@playwright/test';

const DROPPED = /\b(ECONNRESET|ECONNREFUSED|EPIPE)\b|socket hang up/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DROPPED_CALL_BUDGET_MS = 30_000;

export interface Running { title: string; baseURL: string | undefined; note: (text: string) => void }

/** The running Playwright test, or null outside one (a unit test). */
function running(): Running | null {
  try {
    const info = test.info();
    return {
      title: info.title,
      baseURL: info.project.use.baseURL,
      note: (description) => { info.annotations.push({ type: 'dropped-connection', description }); },
    };
  } catch {
    return null;
  }
}

/** A re-send is allowed only against dev/CI localhost; outside a Playwright test (unit tests) there is no host to refuse. */
function mayResend(ctx: Running | null): boolean {
  if (!ctx) return true;
  try {
    return LOCAL_HOSTS.has(new URL(ctx.baseURL ?? '').hostname);
  } catch {
    return false;
  }
}

/** `ctx` is the running test; the default reads it from Playwright, the parameter lets a unit test stand in for one. */
export async function retryDropped<T>(
  call: () => Promise<T>, budgetMs = DROPPED_CALL_BUDGET_MS, ctx: Running | null = running(),
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      const code = DROPPED.exec(String(err))?.[0];
      if (!code || !mayResend(ctx) || Date.now() > deadline) throw err;
      const line = `test="${ctx?.title ?? 'outside a test'}" code=${code} attempt=${attempt}`;
      process.stderr.write(`[dropped-connection] ${line}\n`);
      ctx?.note(line);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
