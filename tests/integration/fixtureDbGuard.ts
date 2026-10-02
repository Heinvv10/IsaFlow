/**
 * The one check behind every "this test may write here" guard on a disposable
 * fixture database: `assertDisposable` (the route suites),
 * `assertChainFixtureDb` (the reversal-chain suites) and
 * `isDisposableFixtureTarget` (tests/unit/mcp/w2/generalLedgerStream.helpers).
 *
 * It reads the URL with `pg-connection-string`'s `parse` — the parser `pg`
 * itself applies to `connectionString` (src/lib/neon.ts) — because that is
 * where the connection actually goes. `new URL()` does not see what pg sees:
 * pg lets query parameters override the authority, so
 * `postgresql://localhost/isaflow_test?host=100.96.203.105&port=7772`
 * reads as localhost to `new URL()` and connects to the dev/production server
 * (rev-d7-35ba3c9f2, MEDIUM). So:
 *
 *   - no query parameter except `sslmode` (host, port, options, … all refused);
 *   - the host pg will use is 127.0.0.1 or localhost (no unix socket);
 *   - not the IsaFlow Supabase stack's own ports on this machine (7770-7776),
 *     which publish the server holding isaflow, isaflow_dev and
 *     isaflow_staging on localhost too;
 *   - the database pg will open is one of `allowedDbs`.
 */
import { parse } from 'pg-connection-string';

/** The IsaFlow Supabase stack's published ports on velo-server — never a fixture. */
const SUPABASE_STACK_PORTS = new Set(['7770', '7771', '7772', '7773', '7774', '7775', '7776']);

/** Why `raw` is not a local fixture database pg would open, or null when it is. */
export function fixtureDbUrlProblem(raw: string | undefined, allowedDbs: readonly string[]): string | null {
  if (!raw) return 'is not set';
  if (!URL.canParse(raw)) return 'is not a URL';
  const extra = [...new URL(raw).searchParams.keys()].filter((k) => k !== 'sslmode');
  if (extra.length > 0) return `may carry no query parameter but sslmode (found ${extra.join(', ')})`;

  const pg = parse(raw);
  if (!pg.host || !['localhost', '127.0.0.1'].includes(pg.host)) {
    return `must connect to localhost (pg reads host ${pg.host ?? 'none'})`;
  }
  if (pg.port && SUPABASE_STACK_PORTS.has(String(pg.port))) {
    return `port ${pg.port} is the IsaFlow Supabase server, not a fixture`;
  }
  if (!pg.database || !allowedDbs.includes(pg.database)) {
    return `must name ${allowedDbs.join(' or ')} (pg opens ${pg.database ?? 'none'})`;
  }
  return null;
}

export function assertLocalFixtureDbUrl(envName: string, raw: string | undefined, allowedDbs: readonly string[]): void {
  const problem = fixtureDbUrlProblem(raw, allowedDbs);
  if (problem) throw new Error(`${envName} ${problem}`);
}
