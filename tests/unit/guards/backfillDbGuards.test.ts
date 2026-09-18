/**
 * The two database allow-lists, and the fact that they DIFFER on purpose.
 *
 * Dev, staging and production differ only in the database NAME on one host and
 * port, so a slip here is one environment variable away at all times. There are
 * two guards because there are two kinds of caller:
 *
 *   · `assertNotProductionDb` governs the mutating test suite, which creates
 *     companies, posts journals and deletes rows. Narrow: dev and test only.
 *   · `assertBackfillDryRunDb` governs the back-fill dry-run script, which
 *     writes nothing and rolls its transaction back. It may also read
 *     `isaflow_staging`, a pg_dump copy of production.
 *
 * The test that matters most is the LAST one: the staging copy is reachable by
 * the read-only script and must stay unreachable by the tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';
import { assertBackfillDryRunDb } from '../../../scripts/lib/assertBackfillDryRunDb';

const ORIGINAL = process.env.DATABASE_URL;

/**
 * No credentials in the URL, deliberately. Both guards read the PATHNAME and
 * nothing else, and a literal `user:pass@` here trips the pre-commit secret
 * scanner — a false positive worth designing out rather than bypassing.
 */
function withDb(name: string): void {
  process.env.DATABASE_URL = `postgres://localhost:5432/${name}`;
}

const GUARDS: [string, (reason: string) => void][] = [
  ['assertNotProductionDb', assertNotProductionDb],
  ['assertBackfillDryRunDb', assertBackfillDryRunDb],
];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe.each(GUARDS)('%s', (_name, guard) => {
  it('refuses production, which is the whole point', () => {
    withDb('isaflow');
    expect(() => guard('It would write.')).toThrow(/"isaflow"/);
    // The caller's reason is quoted, so the operator sees what it would have done.
    expect(() => guard('It would write.')).toThrow(/It would write\./);
  });

  it('allows dev and test', () => {
    for (const name of ['isaflow_dev', 'isaflow_test']) {
      withDb(name);
      expect(() => guard('ok')).not.toThrow();
    }
  });

  it('refuses a live database that is merely NOT named isaflow', () => {
    // The case a deny-list would wave through: a real database, a different
    // name. Also the reason neither list is matched by prefix — this one shares
    // eight characters with isaflow_dev.
    withDb('isaflow_prod_replica');
    expect(() => guard('It would write.')).toThrow(/isaflow_prod_replica/);
  });

  it('passes when DATABASE_URL is absent or unparseable — those runs skip themselves', () => {
    delete process.env.DATABASE_URL;
    expect(() => guard('ok')).not.toThrow();
    process.env.DATABASE_URL = 'not a url';
    expect(() => guard('ok')).not.toThrow();
  });
});

describe('the two lists differ on purpose', () => {
  it('lets the read-only script reach staging and keeps the tests out of it', () => {
    withDb('isaflow_staging');
    expect(() => assertBackfillDryRunDb('Reads only.')).not.toThrow();
    // A pg_dump copy of production. The dry run may read it; ~50 mutating test
    // files share the other guard and must never be able to write to it.
    expect(() => assertNotProductionDb('It would write.')).toThrow(/isaflow_staging/);
  });
});
