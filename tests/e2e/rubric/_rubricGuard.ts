/**
 * The rubric harness's guard (master plan wave 4, MW). Pure: no Playwright, no network, no filesystem, so every refusal
 * is unit-tested (tests/unit/e2e/rubricGuard.test.ts). The runtime half that feeds it is _rubricSession.ts.
 *
 * The harness WRITES on shared dev, where SMTP is live and production answers on localhost:3111/3112 (blue/green) and
 * :80/:3101 (nginx). So, before the first request:
 *   1. the base URL is http://localhost:<port> with the port on the allow-list (3271-3280, the wave's own ports);
 *   2. a separate deny-list refuses the live ports whatever the allow-list says;
 *   3. every *DATABASE_URL the server on that port sees is dev Supabase's isaflow_dev (_rubricDatabaseGuard.ts);
 *   4. the logins are exactly the two dev-only QA users;
 *   5. every write happens in a harness sandbox company, never Demo: the harness Api checks the session's scope before
 *      each write (guardWrites);
 *   6. /api/accounting/invoice-email is fulfilled in the browser, and the run fails if it was not hit or if any request
 *      to it was not fulfilled there; the harness Api refuses it outright;
 *   7. a browser context never switches company (the app's own recovery would move it out of the sandbox).
 */

export const PORT_ALLOW_LIST: readonly number[] = [3271, 3272, 3273, 3274, 3275, 3276, 3277, 3278, 3279, 3280];
/** Production: nginx (80, 3101) and the blue/green colours (3111, 3112). Checked before, and apart from, the allow-list. */
export const PORT_DENY_LIST: readonly number[] = [80, 3101, 3111, 3112];
export const REQUESTER_EMAIL = 'reporting-qa@isaflow.dev';
export const APPROVER_EMAIL = 'reporting-qa-approver@isaflow.dev';
export const SANDBOX_PREFIX = '0RS Rubric Sandbox ';
export const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
export const EMAIL_ROUTE = '/api/accounting/invoice-email';

/** At most 14 characters: the seed's employee numbers are `RBR-<RUN ID>-n`, and the API caps them at 20. */
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,13}$/;

export class RubricGuardError extends Error {
  constructor(message: string) {
    super(`rubric guard: ${message}`);
    this.name = 'RubricGuardError';
  }
}

export function assertPortNotDenied(port: number, deny: readonly number[] = PORT_DENY_LIST): void {
  if (deny.includes(port)) throw new RubricGuardError(`port ${port} is on the deny-list (production): ${deny.join(', ')}`);
}

export function assertPortAllowed(port: number, allow: readonly number[] = PORT_ALLOW_LIST): void {
  if (!allow.includes(port)) throw new RubricGuardError(`port ${port} is not on the allow-list (${allow.join(', ')})`);
}

/** @returns the port. The deny-list is judged first, so no allow-list can let a live port through. */
export function assertBaseUrl(raw: string | undefined, allow: readonly number[] = PORT_ALLOW_LIST,
  deny: readonly number[] = PORT_DENY_LIST): number {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new RubricGuardError(`base URL "${raw ?? ''}" is not a URL`);
  }
  if (url.protocol !== 'http:') throw new RubricGuardError(`base URL must be http://localhost:<port>, got ${url.protocol}`);
  if (url.hostname !== 'localhost') throw new RubricGuardError(`base URL host must be localhost, got ${url.hostname}`);
  if (url.username || url.password) throw new RubricGuardError('base URL must not carry credentials');
  if (url.pathname !== '/' || url.search || url.hash) throw new RubricGuardError('base URL must be the server root');
  const port = url.port === '' ? 80 : Number(url.port);
  assertPortNotDenied(port, deny);
  assertPortAllowed(port, allow);
  return port;
}

/** Exactly the two dev-only QA users, compared as written (no trimming, no case folding). */
export function assertLogins(requester: string | undefined, approver: string | undefined): void {
  if (requester !== REQUESTER_EMAIL) throw new RubricGuardError(`the requester must be ${REQUESTER_EMAIL}, got "${requester ?? ''}"`);
  if (approver !== APPROVER_EMAIL) throw new RubricGuardError(`the approver must be ${APPROVER_EMAIL}, got "${approver ?? ''}"`);
}

export function assertRunId(runId: string | undefined): string {
  if (!runId || !RUN_ID.test(runId)) {
    throw new RubricGuardError(`RUBRIC_RUN_ID must match ${RUN_ID} (e.g. w4-before), got "${runId ?? ''}"`);
  }
  return runId;
}

export const sandboxName = (runId: string): string => `${SANDBOX_PREFIX}${assertRunId(runId)}`;

/** A seeded employee's number (at most 20 characters for a valid run id). */
export const employeeNumber = (runId: string, n: number): string => `RBR-${assertRunId(runId).toUpperCase()}-${n}`;

/** A harness sandbox: never Demo, and named for this run. */
export function assertSandbox(company: { id: string; name: string }, runId: string): void {
  if (company.id.toLowerCase() === DEMO_COMPANY_ID) throw new RubricGuardError('the Demo company is never a sandbox');
  if (company.name !== sandboxName(runId)) {
    throw new RubricGuardError(`company "${company.name}" is not this run's sandbox "${sandboxName(runId)}"`);
  }
}

/** What GET /api/auth/me returns, as far as the guard reads it. */
export interface MeView {
  user: { email: string; id?: string };
  activeCompanyId: string | null;
  memberships: Array<{ company_id: string; name: string }>;
}

/** The session is the expected user, and (with a sandbox) is scoped to it: checked before every write. */
export function assertSession(me: MeView, email: string, sandbox?: { id: string; runId: string }): void {
  if (me.user.email !== email) throw new RubricGuardError(`session belongs to "${me.user.email}", expected ${email}`);
  if (!sandbox) return;
  if (me.activeCompanyId !== sandbox.id) {
    throw new RubricGuardError(`active company is ${me.activeCompanyId ?? 'none'}, not the sandbox ${sandbox.id}`);
  }
  const active = me.memberships.find((m) => m.company_id === sandbox.id);
  if (!active) throw new RubricGuardError(`${email} is not a member of the sandbox ${sandbox.id}`);
  assertSandbox({ id: active.company_id, name: active.name }, sandbox.runId);
}

/** Moves a session to another company. A harness browser context starts in the sandbox and must never leave it. */
export const SWITCH_COMPANY_ROUTE = '/api/auth/switch-company';

/**
 * Is `rawUrl` (absolute, or a path) `path`, as the server would route it: dot segments resolved, percent-escapes decoded,
 * repeated and trailing slashes dropped. A URL that does not parse cannot be requested (false); a path that does not
 * decode is treated as a match, so the route guards fail closed.
 */
function hasPath(rawUrl: string, path: string): boolean {
  let pathname: string;
  try {
    // A path is put under a host by hand: as a relative URL, `//api/...` would name a host called "api".
    pathname = new URL(rawUrl.startsWith('/') ? `http://localhost${rawUrl}` : rawUrl).pathname;
  } catch {
    return false;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') === path;
}

export const isEmailRoute = (rawUrl: string): boolean => hasPath(rawUrl, EMAIL_ROUTE);

/**
 * The page itself can move the session: when a company list read fails, CompanyContext's recovery switches to the
 * user's first live membership (another sandbox, seen 2026-11-06 under load). So a harness context refuses the switch.
 */
export const isSwitchCompanyRoute = (rawUrl: string): boolean => hasPath(rawUrl, SWITCH_COMPANY_ROUTE);

/** The harness Api never calls the email route: the browser intercept is the only way the harness reaches it. */
export function assertNotEmailRoute(path: string): void {
  if (isEmailRoute(path)) throw new RubricGuardError(`the harness never calls the email route (${path})`);
}

/** The write methods of the golden Api (tests/e2e/golden-paths/_api.ts) that the harness uses. */
const WRITE_METHODS = ['post', 'postRaw', 'put', 'del', 'postMultipart'] as const;
type WriteMethod = (typeof WRITE_METHODS)[number];
type Writer = { [M in WriteMethod]: (path: string, ...rest: never[]) => Promise<unknown> };

/**
 * Every write through `api` first refuses the email route, then awaits `beforeWrite` (the session-scope check), and
 * only then sends. Replaces the methods on this instance: the golden Api's constructor is private, so it cannot be
 * extended, and its helpers (fixtureCustomer...) call `this.post`, which now resolves here.
 */
export function guardWrites<T extends Writer>(api: T, beforeWrite: (method: WriteMethod, path: string) => Promise<void>): T {
  for (const method of WRITE_METHODS) {
    const send = api[method].bind(api) as (path: string, ...rest: unknown[]) => Promise<unknown>;
    (api as Record<WriteMethod, unknown>)[method] = async (path: string, ...rest: unknown[]) => {
      assertNotEmailRoute(path);
      await beforeWrite(method, path);
      return send(path, ...rest);
    };
  }
  return api;
}

/** Counts the email route's requests and the ones the harness fulfilled; a request it did not fulfil reached the network. */
export class EmailInterceptTally {
  seen = 0;
  fulfilled = 0;

  onRequest(url: string): void {
    if (isEmailRoute(url)) this.seen++;
  }

  onFulfilled(): void {
    this.fulfilled++;
  }

  assertClean(): void {
    if (this.seen > this.fulfilled) {
      throw new RubricGuardError(`${this.seen - this.fulfilled} request(s) to ${EMAIL_ROUTE} were not intercepted`);
    }
    if (this.fulfilled === 0) throw new RubricGuardError(`the ${EMAIL_ROUTE} intercept was never hit`);
  }
}

/** The pids listening on `port`, from `ss -ltnpH`. */
export function listenerPids(ssOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of ssOutput.split('\n')) {
    const local = line.trim().split(/\s+/)[3] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  return [...pids];
}

/** KEY=VALUE lines; quotes stripped, comments and blank lines skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2]!;
    out[m[1]!] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}
