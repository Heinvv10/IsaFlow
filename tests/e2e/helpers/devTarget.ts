/**
 * The ONE answer to "may an e2e test touch this?" Only dev and CI identities pass; everything else, including anything
 * unreadable, is refused (fail closed).
 *
 * Every spec under tests/e2e calls `guardDevTarget(test)`, except the golden specs without `// golden:dev-only`: those
 * ARE the post-deploy verification and run against a production colour, in the Deploy Verification company
 * (playwright-golden.config.ts). tests/unit/guards/e2eDevTargetCensus.test.ts keeps both sides true.
 *
 * `guardDevTarget` overrides the `baseURL` fixture instead of registering a `beforeAll`: Playwright runs a file's other
 * beforeAll and afterAll hooks after one of them throws, so a hook guard does not stop the writes. A failing baseURL
 * fixture stops every hook and test of the file (tests/unit/e2e/devTargetRunner.test.ts).
 *
 * A second, automatic fixture judges the FINAL values: a `test.use({ baseURL })` further down a file replaces the
 * override above, and a saved session (`storageState`) holding another host's cookies or local storage would be restored
 * on a redirect (a dev server without NEXT_PUBLIC_ADMIN_URL sends /admin/* to the production admin host). `all-hooks-included` is Playwright's
 * own (unlisted) mode that also sets the fixture up for beforeAll and afterAll hooks; the runner test pins it.
 *
 * Named limits: over HTTP a dev server cannot be asked which database it uses, so a server on a dev port that was started
 * with production's env is not detected (the *DATABASE_URL keys of the runner's own env are judged). Other applications
 * on velo-server listen inside the dev port range; they do not serve IsaFlow's API, but a mistyped port there would still
 * be sent the dev login. A context a spec builds itself with
 * its own storageState or address is judged only by the census. After a refusal further down a file, an `afterEach` that
 * asks for no fixture, or only for `browser`, still runs.
 */
import { readFileSync } from 'node:fs';

/** Production on velo-server: nginx (80, 443, 3101) and the blue/green colours (3111, 3112). Judged before the range. */
export const PRODUCTION_PORTS: readonly number[] = [80, 443, 3101, 3111, 3112];
/** The blue/green colours (BG_PORTS in scripts/deploy/bluegreen.sh): all a deploy run may name. */
export const COLOUR_PORTS: readonly number[] = [3111, 3112];
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

/**
 * A deploy run: scripts/verify-deploy.sh's two switches, plus a colour port and a run marker, which it hands on from
 * VERIFY_COLOUR_PORT and VERIFY_DEPLOY_RUN. deploy, restart-colours and cutover set those for the colour they are
 * changing; a person verifying a colour by hand sets them too. The marker is only checked for presence, and the guard
 * does not know which colour is live.
 */
export function isDeployRun(env: Env): boolean {
  return env.GOLDEN_SKIP_A11Y === '1' && env.GOLDEN_POST_DEPLOY === '1' && Boolean(env.GOLDEN_DEPLOY_PORT) && Boolean(env.GOLDEN_DEPLOY_RUN);
}

/**
 * What the golden setup judges before it sends a login. In a deploy run: exactly http://localhost:<the colour under
 * deploy>, so a mistyped port never hands the credentials to another service on this machine. Otherwise dev and CI only.
 */
export function assertGoldenTarget(raw: string, env: Env = process.env): string {
  if (!isDeployRun(env)) return assertDevOrCiTarget(raw, env);
  const port = env.GOLDEN_DEPLOY_PORT;
  if (!COLOUR_PORTS.some((p) => String(p) === port)) {
    throw new DevTargetError('GOLDEN_DEPLOY_PORT', `is "${port}", not a colour port (${COLOUR_PORTS.join(', ')})`);
  }
  if (raw !== `http://localhost:${port}`) {
    throw new DevTargetError('post-deploy base URL', `is not http://localhost:${port}, the colour under deploy`);
  }
  return raw;
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

/** For a spec or script that addresses the server itself instead of through Playwright's baseURL. */
export function devBaseUrl(raw: string | undefined = process.env.BASE_URL): string {
  return assertDevOrCiTarget(raw || DEFAULT_DEV_BASE_URL);
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
    baseURL: async ({ baseURL }, use) => { await use(assertDevOrCiTarget(baseURL)); },
    _devTargetGuard: [async ({ baseURL, storageState }, use) => {
      assertDevOrCiTarget(baseURL);
      assertDevStorageState(storageState);
      await use();
    }, { auto: 'all-hooks-included' }],
    // A failed automatic fixture does not stop a later beforeEach or afterEach; one that needs a failed fixture does not run.
    // `page` is built from `context`, so it is covered by it.
    request: async ({ request, _devTargetGuard }, use) => { void _devTargetGuard; await use(request); },
    context: async ({ context, _devTargetGuard }, use) => { void _devTargetGuard; await use(context); },
  };
  test.use(fixtures as never);
}
