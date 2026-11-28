/**
 * The ONE answer to "may an e2e test touch this?" Only dev and CI identities pass; everything else, including anything
 * unreadable, is refused (fail closed).
 *
 * Every spec under tests/e2e calls `guardDevTarget(test)`, except the golden specs without `// golden:dev-only`: those
 * ARE the post-deploy verification and run against a production colour, in the Deploy Verification company
 * (playwright-golden.config.ts). tests/unit/guards/e2eDevTargetCensus.test.ts keeps both sides true.
 *
 * `guardDevTarget` overrides the `baseURL` fixture instead of registering a `beforeAll`: Playwright runs a file's other
 * beforeAll and afterAll hooks after one of them throws, so a hook guard does not stop the writes. A failing guard
 * fixture stops the tests, the beforeAll and afterAll hooks, and every beforeEach or afterEach that asks for page,
 * context or request (tests/unit/e2e/devTargetRunner.test.ts). One that asks for none of them still runs, so the census
 * refuses it in a spec.
 *
 * A second, automatic fixture judges the FINAL values: a `test.use({ baseURL })` further down a file replaces the
 * override above, and a saved session (`storageState`) holding another host's cookies or local storage would be restored
 * on a redirect (a dev server without NEXT_PUBLIC_ADMIN_URL sends /admin/* to the production admin host). `all-hooks-included` is Playwright's
 * own (unlisted) mode that also sets the fixture up for beforeAll and afterAll hooks; the runner test pins it.
 *
 * A server is also asked which database it is on (assertDevServer): one started with production's env is refused,
 * whatever its port, and so is anything on a dev port that cannot answer (another application, an older IsaFlow branch).
 *
 * Named limits: the answer is asked once per address and worker, and covers the databases only: a server with test
 * databases but another environment's auth or storage service (GOTRUE_URL, SUPABASE_URL) still says yes. A context a spec
 * builds itself with its own storageState or address is judged only by the census.
 */
import { readFileSync } from 'node:fs';

/** Production on velo-server: nginx (80, 443, 3101) and the blue/green colours (3111, 3112). Judged before the range. */
export const PRODUCTION_PORTS: readonly number[] = [80, 443, 3101, 3111, 3112];
/** Dev and CI app servers. */
export const DEV_PORT_MIN = 3200;
export const DEV_PORT_MAX = 3799;
export const DEFAULT_DEV_BASE_URL = 'http://localhost:3200';

/** Dev Supabase on velo-server. Production's database is `isaflow` on the SAME host and port: the name is what differs. */
export const DEV_DB_HOST = '100.96.203.105';
export const DEV_DB_PORT = 7772;
export const DEV_DATABASE = 'isaflow_dev';
/** The throwaway database of a hosted golden run (scripts/ci/golden-hosted/up.sh), loopback only and only with the CI marker. */
export const CI_DATABASE = 'isaflow_golden';

const APP_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];
/** Query parameters that cannot move a connection. pg reads host, port, dbname, options... from the query string. */
const SAFE_DB_PARAMS: readonly string[] = ['sslmode', 'application_name', 'connect_timeout'];

type Env = Record<string, string | undefined>;

export class DevTargetError extends Error {
  constructor(what: string, why: string) {
    super(`e2e dev-target guard: ${what} ${why}. E2E tests run against dev and CI only (tests/e2e/helpers/devTarget.ts)`);
    this.name = 'DevTargetError';
  }
}

/** @returns `raw` when it is a dev/CI app server: http://localhost|127.0.0.1:<3200-3799>. */
export function assertDevOrCiBaseUrl(raw: string | undefined, what = 'base URL'): string {
  const refuse = (why: string): never => { throw new DevTargetError(what, why); };
  if (!raw) return refuse('is not set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse(`has protocol ${url.protocol}`);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!APP_HOSTS.includes(url.hostname)) return refuse(`names host "${url.hostname}", not localhost`);
  if (PRODUCTION_PORTS.includes(port)) return refuse(`names port ${port}, a production port`);
  if (url.protocol !== 'http:') return refuse('must be plain http on localhost');
  if (url.username || url.password) return refuse('carries credentials');
  if (port < DEV_PORT_MIN || port > DEV_PORT_MAX) return refuse(`names port ${port}, outside the dev ports ${DEV_PORT_MIN}-${DEV_PORT_MAX}`);
  return raw;
}

/** @returns `raw` when it is dev's isaflow_dev, or (GITHUB_ACTIONS=true) a loopback isaflow_golden. */
export function assertDevOrCiDatabaseUrl(raw: string | undefined, env: Env, what = 'DATABASE_URL'): string {
  // The message never echoes the url: it carries a password.
  const refuse = (why: string): never => { throw new DevTargetError(what, why); };
  if (!raw) return refuse('is empty (pg would connect to its defaults)');
  let url: URL;
  let database: string;
  try {
    url = new URL(raw);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return refuse('is not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return refuse('is not a postgres URL');
  for (const name of url.searchParams.keys()) {
    if (!SAFE_DB_PARAMS.includes(name)) return refuse(`carries the query parameter "${name}"`);
  }
  const port = Number(url.port);
  const isDev = url.hostname === DEV_DB_HOST && port === DEV_DB_PORT && database === DEV_DATABASE;
  // Never on the shared stack's port: velo's own loopback 7772 is the server that holds production.
  const isCi = env.GITHUB_ACTIONS === 'true' && APP_HOSTS.includes(url.hostname) && url.port !== '' && port !== DEV_DB_PORT
    && database === CI_DATABASE;
  if (!isDev && !isCi) return refuse(`names ${url.hostname}:${url.port || '(default)'}/${database}, which is neither dev nor a CI database`);
  return raw;
}

/** Judges every database URL the runner's env holds. An empty value is no database. */
export function assertDevOrCiDatabaseEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (value && (key.includes('DATABASE_URL') || key === 'GOLDEN_HOSTED_DB_URL')) assertDevOrCiDatabaseUrl(value, env, key);
  }
}

/** The app server and the runner's databases, together. @returns the base URL. */
export function assertDevOrCiTarget(baseURL: string | undefined, env: Env = process.env): string {
  const url = assertDevOrCiBaseUrl(baseURL);
  assertDevOrCiDatabaseEnv(env);
  return url;
}

interface SavedSession { cookies?: ReadonlyArray<{ domain: string }>; origins?: ReadonlyArray<{ origin: string }> }
type StorageState = string | SavedSession | undefined;

/**
 * A saved session may carry cookies for this machine only, and local storage (`origins`, IndexedDB included) for dev
 * and CI servers only. A file that cannot be read is refused.
 */
export function assertDevStorageState(state: StorageState): void {
  if (state === undefined) return;
  let cookies: ReadonlyArray<{ domain: string }>;
  let origins: ReadonlyArray<{ origin: string }>;
  try {
    const parsed = typeof state === 'string' ? (JSON.parse(readFileSync(state, 'utf8')) as SavedSession) : state;
    cookies = [...(parsed.cookies ?? [])];
    origins = [...(parsed.origins ?? [])];
  } catch (e) {
    throw new DevTargetError('storageState', `cannot be read (${e instanceof Error ? e.message : String(e)})`);
  }
  const foreign = cookies.find((c) => !APP_HOSTS.includes(c.domain));
  if (foreign) throw new DevTargetError('storageState', `holds a cookie for "${foreign.domain}", not localhost`);
  for (const saved of origins) assertDevOrCiBaseUrl(saved?.origin, 'storageState origin');
}

/** The server's own answer (pages/api/health/test-database.ts). */
export const TEST_DATABASE_PATH = '/api/health/test-database';
/** Long enough for a dev server to compile the route on its first request. */
const ANSWER_MS = 60_000;
const confirmed = new Set<string>();

/** Refuses a server that does not say it is on a dev or CI database. Only a yes is remembered. */
export async function assertDevServer(baseUrl: string): Promise<void> {
  const url = new URL(TEST_DATABASE_PATH, assertDevOrCiBaseUrl(baseUrl)).href;
  if (confirmed.has(url)) return;
  const refuse = (why: string): never => { throw new DevTargetError(`the server at ${new URL(url).origin}`, why); };
  let answer: { testDatabase?: unknown } | null;
  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(ANSWER_MS) });
    answer = (await res.json()) as { testDatabase?: unknown } | null;
  } catch (e) {
    return refuse(`did not answer ${TEST_DATABASE_PATH} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (answer?.testDatabase !== true) return refuse(`does not report a dev or CI database at ${TEST_DATABASE_PATH}`);
  confirmed.add(url);
}

/** Every address a spec took for itself: each is asked for its database along with the config's. */
const named = new Set<string>();

/** For a spec or script that addresses the server itself instead of through Playwright's baseURL. */
export function devBaseUrl(raw: string | undefined = process.env.BASE_URL): string {
  const url = assertDevOrCiTarget(raw || DEFAULT_DEV_BASE_URL);
  named.add(url);
  return url;
}

/** The built-in fixture, unchanged, but only after the guard passed. */
type Gated<K extends string> = (args: Record<K | '_devTargetGuard', unknown>, use: (value: unknown) => Promise<void>) => Promise<void>;

interface GuardFixtures {
  baseURL: (args: { baseURL: string | undefined }, use: (value: string) => Promise<void>) => Promise<void>;
  _devTargetGuard: [
    (args: { baseURL: string | undefined; storageState: StorageState }, use: () => Promise<void>) => Promise<void>,
    { auto: 'all-hooks-included' },
  ];
  request: Gated<'request'>;
  context: Gated<'context'>;
}

/** Call once, at the top level of a spec file, before any hook or test. */
export function guardDevTarget(test: { use(fixtures: never): void }): void {
  const fixtures: GuardFixtures = {
    baseURL: async ({ baseURL }, use) => {
      const url = assertDevOrCiTarget(baseURL);
      for (const target of [url, ...named]) await assertDevServer(target);
      await use(url);
    },
    _devTargetGuard: [async ({ baseURL, storageState }, use) => {
      const url = assertDevOrCiTarget(baseURL);
      assertDevStorageState(storageState);
      await assertDevServer(url);
      await use();
    }, { auto: 'all-hooks-included' }],
    // A failed automatic fixture does not stop a later beforeEach or afterEach; one that needs a failed fixture does not run.
    // `page` is built from `context`, so it is covered by it.
    request: async ({ request, _devTargetGuard }, use) => { void _devTargetGuard; await use(request); },
    context: async ({ context, _devTargetGuard }, use) => { void _devTargetGuard; await use(context); },
  };
  test.use(fixtures as never);
}
