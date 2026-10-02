/**
 * Guard for integration tests that may ONLY write to a throwaway database.
 *
 * `assertNotProductionDb` allows `isaflow_dev`, which is a shared database
 * other sessions and a running dev server read. A test that seeds whole
 * companies, journals and filings has no business there. This allows only a
 * database on this machine named for the purpose: the fixture
 * (`isaflow_schema_fixture`) or a test database (`isaflow_test`).
 *
 * An absent DATABASE_URL is not an error — the DB-gated suites skip
 * themselves in that case.
 */
const DISPOSABLE_DB_NAMES = ['isaflow_schema_fixture', 'isaflow_test'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Whether DATABASE_URL names a disposable database on this machine. */
export function isDisposableDb(url: string | undefined = process.env.DATABASE_URL): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, '').split('?')[0] ?? '';
    return LOCAL_HOSTS.includes(parsed.hostname) && DISPOSABLE_DB_NAMES.includes(name);
  } catch {
    return false;
  }
}

/** Throw unless DATABASE_URL names a disposable database on this machine. */
export function assertDisposableDb(reason: string): void {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  if (!isDisposableDb(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL is not a disposable database on this machine `
      + `(${DISPOSABLE_DB_NAMES.join(' / ')} on localhost). ${reason}`,
    );
  }
}
