/* eslint-disable no-console -- CLI utility, not request-context code; structured
 * logging via @/lib/logger pulls in observability/requestContext which has no
 * meaningful state in a one-off script. Matches apply-migrations.ts precedent. */
/**
 * Resolver for schema_migrations checksum conflicts.
 *
 * Use when a migration file has been edited (e.g. follow-up fix-up commit,
 * or two parallel sessions staged different drafts) and the dev DB's stored
 * checksum no longer matches the file's SHA-256 — this blocks the runner.
 *
 * For each named migration, re-runs the SQL inside a transaction (must be
 * idempotent — `IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, guard blocks
 * for INSERT-once rows) and updates schema_migrations.checksum to match
 * the current file. Skips files that already match. Aggregates per-file
 * pass/fail at the end rather than aborting on first error.
 *
 * Usage:
 *   bun scripts/migrations/resolve-checksum-conflicts.ts <filename> [<filename> ...]
 *
 * Filenames are bare migration filenames (e.g. `483_bfc_fk_to_gl_accounts.sql`),
 * not full paths. Pass at least one — the script intentionally has no
 * defaults so it's never run blindly.
 *
 * SAFETY: if the migration is NOT idempotent (creates duplicate rows on
 * re-run), do not use this — write a follow-up migration instead.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import pg from 'pg';

const MIGRATIONS_DIR = resolve(process.cwd(), 'scripts', 'migrations', 'sql');

// Allow only standard migration filenames: numeric prefix (with optional letter
// suffix like `244b`), underscore, alphanumeric/dash/underscore body, `.sql`
// extension. Rejects path separators, parent traversal, or any other shenanigans.
const FILENAME_RX = /^\d+[a-z]?_[a-zA-Z0-9_-]+\.sql$/;

const TARGETS = process.argv.slice(2);
if (TARGETS.length === 0) {
  console.error('Usage: bun scripts/migrations/resolve-checksum-conflicts.ts <filename> [...]');
  console.error('Pass at least one migration filename (e.g. 483_bfc_fk_to_gl_accounts.sql).');
  process.exit(1);
}

interface FileResult {
  filename: string;
  status: 'fixed' | 'skip-already-matches' | 'skip-not-tracked' | 'rejected' | 'error';
  detail?: string;
}

function resolveSafePath(filename: string): string {
  if (isAbsolute(filename)) {
    throw new Error(`refusing absolute path: ${filename}`);
  }
  if (!FILENAME_RX.test(filename)) {
    throw new Error(
      `invalid filename: ${filename} (must match ${FILENAME_RX} — bare migration filename, no path separators)`,
    );
  }
  const target = resolve(MIGRATIONS_DIR, filename);
  const rel = relative(MIGRATIONS_DIR, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes migrations directory: ${filename}`);
  }
  return target;
}

async function processOne(client: pg.PoolClient, filename: string): Promise<FileResult> {
  let safePath: string;
  try {
    safePath = resolveSafePath(filename);
  } catch (err) {
    return {
      filename,
      status: 'rejected',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const content = readFileSync(safePath, 'utf8');
  const checksum = createHash('sha256').update(content).digest('hex');
  const prior = await client.query<{ checksum: string | null }>(
    'SELECT checksum FROM schema_migrations WHERE name = $1',
    [filename],
  );
  if (prior.rows.length === 0) {
    return { filename, status: 'skip-not-tracked' };
  }
  const dbChecksum = prior.rows[0]?.checksum ?? null;
  if (dbChecksum === checksum) {
    return { filename, status: 'skip-already-matches' };
  }
  await client.query('BEGIN');
  try {
    await client.query(content);
    await client.query(
      'UPDATE schema_migrations SET checksum = $1, applied_at = now() WHERE name = $2',
      [checksum, filename],
    );
    await client.query('COMMIT');
    return {
      filename,
      status: 'fixed',
      detail: `${(dbChecksum ?? 'null').slice(0, 8)} -> ${checksum.slice(0, 8)}`,
    };
  } catch (err) {
    // Preserve the original error even if ROLLBACK itself fails (broken connection
    // would otherwise mask the root cause).
    try {
      await client.query('ROLLBACK');
    } catch {
      /* swallow — original err takes precedence */
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const directUrl = url
    .replace('-pooler.', '.')
    .replace('&channel_binding=require', '')
    .replace('?channel_binding=require', '?');
  const pool = new pg.Pool({ connectionString: directUrl, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  const results: FileResult[] = [];
  try {
    for (const filename of TARGETS) {
      try {
        results.push(await processOne(client, filename));
      } catch (err) {
        results.push({
          filename,
          status: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  for (const r of results) {
    const line = r.detail ? `${r.status}  ${r.filename}: ${r.detail}` : `${r.status}  ${r.filename}`;
    if (r.status === 'rejected' || r.status === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  const failed = results.filter((r) => r.status === 'rejected' || r.status === 'error').length;
  if (failed > 0) {
    console.error(`\n${failed} file(s) failed; see above.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
