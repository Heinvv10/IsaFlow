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
 * Named limit: over HTTP a dev server cannot be asked which database it uses, so a server on a dev port that was started
 * with production's env is not detected. The *DATABASE_URL keys of the runner's own env are judged.
 */

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
  const isCi = env.GITHUB_ACTIONS === 'true' && APP_HOSTS.includes(url.hostname) && url.port !== '' && database === CI_DATABASE;
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

/** For a spec or script that addresses the server itself instead of through Playwright's baseURL. */
export function devBaseUrl(raw: string | undefined = process.env.BASE_URL): string {
  return assertDevOrCiTarget(raw || DEFAULT_DEV_BASE_URL);
}

interface BaseUrlFixtures {
  baseURL: (args: { baseURL: string | undefined }, use: (value: string) => Promise<void>) => Promise<void>;
}

/** Call once, at the top level of a spec file, before any hook or test. */
export function guardDevTarget(test: { use(fixtures: never): void }): void {
  const fixtures: BaseUrlFixtures = {
    baseURL: async ({ baseURL }, use) => { await use(assertDevOrCiTarget(baseURL)); },
  };
  test.use(fixtures as never);
}
