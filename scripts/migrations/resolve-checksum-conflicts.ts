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
 * the current file. Skips files that already match.
 *
 * Usage:
 *   bun scripts/migrations/resolve-checksum-conflicts.ts <filename> [<filename> ...]
 *
 * Filenames are the bare migration filenames (e.g. `483_bfc_fk_to_gl_accounts.sql`),
 * not full paths. Pass at least one — the script intentionally has no
 * defaults so it's never run blindly.
 *
 * SAFETY: if the migration is NOT idempotent (creates duplicate rows on
 * re-run), do not use this — write a follow-up migration instead.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const TARGETS = process.argv.slice(2);
if (TARGETS.length === 0) {
  console.error('Usage: bun scripts/migrations/resolve-checksum-conflicts.ts <filename> [...]');
  console.error('Pass at least one migration filename (e.g. 483_bfc_fk_to_gl_accounts.sql).');
  process.exit(1);
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
  try {
    for (const filename of TARGETS) {
      const content = readFileSync(join(process.cwd(), 'scripts', 'migrations', 'sql', filename), 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const prior = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [filename],
      );
      if (prior.rows.length === 0) {
        console.log(`skip ${filename}: not in schema_migrations`);
        continue;
      }
      const dbChecksum = prior.rows[0]?.checksum ?? null;
      if (dbChecksum === checksum) {
        console.log(`skip ${filename}: already matches`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(content);
        await client.query(
          'UPDATE schema_migrations SET checksum = $1, applied_at = now() WHERE name = $2',
          [checksum, filename],
        );
        await client.query('COMMIT');
        console.log(`fixed ${filename}: ${(dbChecksum ?? 'null').slice(0, 8)} -> ${checksum.slice(0, 8)}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
