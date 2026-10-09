/**
 * Guard for tests/integration/migration-parity-gate.int.test.ts, which creates
 * and DROPs databases and schemas. It refuses (throws, before any connection)
 * unless PARITY_TEST_PG_URL is a loopback throwaway server that is clearly not
 * the IsaFlow Supabase stack (ports 7770-7776) and not the DATABASE_URL server.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const STACK_PORTS = [7770, 7771, 7772, 7773, 7774, 7775, 7776];

function hostPort(raw: string): { host: string; port: number } | null {
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port || 5432) };
  } catch {
    return null;
  }
}

export function assertParityTestUrl(
  url: string | undefined,
  env: { PARITY_TEST_PG_DISPOSABLE?: string; DATABASE_URL?: string }
): void {
  if (env.PARITY_TEST_PG_DISPOSABLE !== '1') {
    throw new Error('set PARITY_TEST_PG_DISPOSABLE=1 to confirm PARITY_TEST_PG_URL is a throwaway Postgres you started');
  }
  const target = url ? hostPort(url) : null;
  if (!url || !target) throw new Error('PARITY_TEST_PG_URL is unset or not a URL');
  if (!LOOPBACK.has(target.host)) throw new Error(`PARITY_TEST_PG_URL host must be loopback, got ${target.host}`);
  if (STACK_PORTS.includes(target.port)) throw new Error('PARITY_TEST_PG_URL port is in the IsaFlow stack range 7770-7776; refusing');
  // pg-connection-string lets ?host= / ?port= / ?hostaddr= / ?dbname= override the authority and path that
  // are checked here, so the only query parameter allowed is sslmode.
  for (const key of new URL(url).searchParams.keys()) {
    if (key !== 'sslmode') throw new Error(`PARITY_TEST_PG_URL has query parameter "${key}"; only sslmode is allowed`);
  }
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (dbName.includes('%')) throw new Error('PARITY_TEST_PG_URL database name is double-encoded; refusing');
  if (dbName === 'isaflow' || dbName === 'isaflow_dev') throw new Error(`PARITY_TEST_PG_URL names database ${dbName}; refusing`);
  const real = env.DATABASE_URL ? hostPort(env.DATABASE_URL) : null;
  if (real && real.port === target.port && (real.host === target.host || LOOPBACK.has(real.host))) {
    throw new Error('PARITY_TEST_PG_URL points at the same server as DATABASE_URL; refusing');
  }
}

/**
 * Server-side check, run on the first admin connection BEFORE any CREATE/DROP: a throwaway
 * server holds nothing but the system databases and parity_* ones. Catches a tunnel or an
 * unlisted port that leads to a real server, which the URL checks cannot see.
 */
export function assertOnlyThrowawayDatabases(names: string[]): void {
  const foreign = names.filter((n) => !['postgres', 'template0', 'template1'].includes(n) && !n.startsWith('parity_'));
  if (foreign.length > 0) {
    throw new Error(`server holds database(s) that are not a throwaway (${foreign.slice(0, 5).join(', ')}); refusing`);
  }
}
