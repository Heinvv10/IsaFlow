/**
 * The guard that stands between a mutating run and production.
 *
 * Dev, staging and production differ only in the database NAME on one host and
 * port, so this is one env slip away at all times. An ALLOW-list is the whole
 * design: a deny-list catches only the exact production name and waves through
 * any other live database somebody points the URL at.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

const ORIGINAL = process.env.DATABASE_URL;

/**
 * No credentials in the URL, deliberately. The guard reads the PATHNAME and
 * nothing else, and a literal `user:pass@` here trips the pre-commit secret
 * scanner — a false positive worth designing out rather than bypassing.
 */
function withDb(name: string): void {
  process.env.DATABASE_URL = `postgres://localhost:5432/${name}`;
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe('assertNotProductionDb', () => {
  it('refuses production, which is the whole point', () => {
    withDb('isaflow');
    expect(() => assertNotProductionDb('It would write.')).toThrow(/"isaflow"/);
    // The caller's reason is quoted, so the operator sees what it would have done.
    expect(() => assertNotProductionDb('It would write.')).toThrow(/It would write\./);
  });

  it('allows the three disposable databases by name', () => {
    for (const name of ['isaflow_dev', 'isaflow_test', 'isaflow_staging']) {
      withDb(name);
      expect(() => assertNotProductionDb('ok')).not.toThrow();
    }
  });

  it('refuses a live database that is merely NOT named isaflow', () => {
    // The case a deny-list would miss: a real database, a different name.
    withDb('isaflow_prod_replica');
    expect(() => assertNotProductionDb('It would write.')).toThrow(/isaflow_prod_replica/);
  });

  it('passes when DATABASE_URL is absent or unparseable — those runs skip themselves', () => {
    delete process.env.DATABASE_URL;
    expect(() => assertNotProductionDb('ok')).not.toThrow();
    process.env.DATABASE_URL = 'not a url';
    expect(() => assertNotProductionDb('ok')).not.toThrow();
  });
});
