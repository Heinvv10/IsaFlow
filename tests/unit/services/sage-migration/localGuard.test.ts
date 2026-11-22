/** The runner's database guard: only a local throwaway database passes, whatever the URL's spelling. */
import { describe, expect, it } from 'vitest';
import { assertLocalDatabase, localDbProblem } from '@/modules/accounting/services/sage-migration/localGuard';

const ok = (u: string) => expect(localDbProblem(u), u).toBeNull();
const no = (u: string, why?: RegExp) => {
  const p = localDbProblem(u);
  expect(p, u).not.toBeNull();
  if (why) expect(p).toMatch(why);
};

describe('localDbProblem', () => {
  it('accepts a local fixture, test or sagemig database with an explicit port', () => {
    ok('postgresql://postgres@127.0.0.1:41234/isaflow_schema_fixture');
    ok('postgresql://postgres@localhost:5433/isaflow_test?sslmode=disable');
    ok('postgresql://postgres@127.0.0.1:5433/isaflow_sagemig_run1');
  });
  it('refuses the dev and production databases, on any host', () => {
    no('postgresql://postgres@127.0.0.1:5433/isaflow_dev', /must name/);
    no('postgresql://postgres@127.0.0.1:5433/isaflow', /must name/);
    no('postgresql://postgres@127.0.0.1:5433/isaflow_staging', /must name/);
    no('postgresql://postgres@100.96.203.105:5433/isaflow_test', /localhost/);
    no('postgresql://postgres@db.example.supabase.co:5432/isaflow_test', /localhost/);
  });
  it('refuses the IsaFlow Supabase stack ports on localhost, even for a throwaway name', () => {
    for (const port of [7770, 7772, 7776]) no(`postgresql://postgres@127.0.0.1:${port}/isaflow_test`, /Supabase/);
  });
  it('refuses a URL with no port (pg would take PGPORT)', () => {
    no('postgresql://postgres@127.0.0.1/isaflow_test', /port/);
    no('postgresql://postgres@localhost:/isaflow_test', /port/);
  });
  it('refuses a ?host= or ?port= override that redirects a localhost-looking URL', () => {
    no('postgresql://127.0.0.1:5433/isaflow_test?host=100.96.203.105&port=7772', /query parameter/);
    no('postgresql://127.0.0.1:5433/isaflow_test?options=-c%20search_path=x', /query parameter/);
  });
  it('refuses a unix socket, a missing URL and text that is not a URL', () => {
    no('postgresql://%2Fvar%2Frun%2Fpostgresql:5433/isaflow_test');
    no('not a url');
    expect(localDbProblem(undefined)).toBe('is not set');
    expect(localDbProblem('')).toBe('is not set');
  });
  it('refuses a name that only starts like an allowed one', () => {
    no('postgresql://postgres@127.0.0.1:5433/isaflow_test2');
    no('postgresql://postgres@127.0.0.1:5433/isaflow_sagemig_');
    no('postgresql://postgres@127.0.0.1:5433/isaflow_sagemig_A;drop');
  });
});

describe('assertLocalDatabase', () => {
  const local = 'postgresql://postgres@127.0.0.1:5433/isaflow_test';
  it('passes when DATABASE_URL is local and no other URL is set', () => {
    expect(() => assertLocalDatabase({ DATABASE_URL: local })).not.toThrow();
  });
  it('throws naming DATABASE_URL when it is missing or not local', () => {
    expect(() => assertLocalDatabase({})).toThrow(/DATABASE_URL is not set/);
    expect(() => assertLocalDatabase({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:7772/isaflow_dev' })).toThrow(/DATABASE_URL/);
  });
  it('also checks the service, platform-admin and migration-admin URLs when set (the service pool prefers its own)', () => {
    for (const name of ['SERVICE_DATABASE_URL', 'PLATFORM_ADMIN_DATABASE_URL', 'MIGRATION_ADMIN_DATABASE_URL']) {
      expect(() => assertLocalDatabase({ DATABASE_URL: local, [name]: 'postgresql://svc@100.96.203.105:7772/isaflow' })).toThrow(new RegExp(name));
      expect(() => assertLocalDatabase({ DATABASE_URL: local, [name]: local })).not.toThrow();
    }
  });
});
