/**
 * Re-issue an idempotent API call the dev server dropped.
 *
 * The hosted Golden lane runs against `next dev`, which drops sockets while it compiles a route or closes an idle
 * keep-alive connection the client is about to reuse; Playwright's APIRequestContext then rejects with
 * `read ECONNRESET` (#1110: `GET .../components` right after a long UI step, and `POST /api/auth/switch-company`
 * in a beforeEach). The request never reached a handler, so for a GET or an idempotent POST sending it again is the
 * same as sending it once. Only a dropped connection is retried, and only until the budget is spent; any other error
 * and any HTTP status goes straight to the caller, so a real failure still fails the test.
 */

const DROPPED = /\b(ECONNRESET|ECONNREFUSED|EPIPE)\b|socket hang up/;

export const DROPPED_CALL_BUDGET_MS = 30_000;

export async function retryDropped<T>(call: () => Promise<T>, budgetMs = DROPPED_CALL_BUDGET_MS): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!DROPPED.test(String(err)) || Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
