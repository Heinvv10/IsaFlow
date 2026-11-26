/**
 * Is this server on a dev or CI database? The e2e guard (tests/e2e/helpers/devTarget.ts) asks before a spec may write:
 * the address of a server says nothing about the database it was started with.
 */
export const TEST_DATABASES: readonly string[] = ['isaflow_dev', 'isaflow_golden'];

function databaseName(url: string): string | null {
  try {
    const parsed = new URL(url);
    // pg lets the query string replace the database or host the URL names.
    if (['dbname', 'database', 'host', 'service', 'options'].some((p) => parsed.searchParams.has(p))) return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/**
 * True only when the connected database AND every `*DATABASE_URL` the server holds name a test database: the app opens
 * more than one pool.
 */
export function isTestDatabaseServer(connected: unknown, env: Record<string, string | undefined>): boolean {
  if (typeof connected !== 'string' || !TEST_DATABASES.includes(connected)) return false;
  return Object.entries(env).every(([key, value]) => {
    if (!value || !key.includes('DATABASE_URL')) return true;
    const name = databaseName(value);
    return name !== null && TEST_DATABASES.includes(name);
  });
}
