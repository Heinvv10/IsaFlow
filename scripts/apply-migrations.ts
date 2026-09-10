/**
 * Idempotent migration runner.
 *
 * Usage:
 *   bun scripts/apply-migrations.ts             # apply pending
 *   bun scripts/apply-migrations.ts --dry-run   # print plan, no writes
 *   bun scripts/apply-migrations.ts --backfill  # mark pending as applied without running SQL
 *
 * Reads *.sql from scripts/migrations/sql/, sorts by numeric prefix,
 * skips ones in schema_migrations, refuses on checksum mismatch.
 *
 * Uses pg_advisory_lock(73014132) to prevent concurrent runners.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';
import { makeNoticeListener } from './migrationNoticeListener';

const ADVISORY_LOCK_KEY = 73014132;
const MIGRATIONS_DIR = join(process.cwd(), 'scripts', 'migrations', 'sql');

export interface MigrationFile {
  version: string;
  name: string;
  content: string;
  checksum: string;
}

export interface TrackingRow {
  version: string;
  name: string;
  checksum: string | null;
}

export interface ApplyPlan {
  toApply: MigrationFile[];
  skipped: MigrationFile[];
  /** Rows already applied but with null checksum (legacy tracking) — safe to record checksum. */
  checksumBackfills: MigrationFile[];
  conflicts: Array<{ version: string; name: string; fileChecksum: string; dbChecksum: string | null }>;
}

export function parseVersionFromFilename(filename: string): string {
  // Accept digits optionally followed by a single lowercase letter (e.g. "244b_...").
  const match = /^(\d+[a-z]?)_/.exec(filename);
  if (!match) {
    throw new Error(`Migration filename missing numeric prefix: ${filename}`);
  }
  return match[1]!;
}

export function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function planApply(files: MigrationFile[], applied: TrackingRow[]): ApplyPlan {
  // Track by filename (name), not version: historical repo contains 9 cases
  // where two different files share the same numeric prefix (e.g. both
  // "245_inventory.sql" and "245_company_settings.sql" exist), so version
  // is not unique. Filename is the only reliable identity.
  const appliedByName = new Map(applied.map((a) => [a.name, a]));
  const toApply: MigrationFile[] = [];
  const skipped: MigrationFile[] = [];
  const checksumBackfills: MigrationFile[] = [];
  const conflicts: ApplyPlan['conflicts'] = [];

  // Sort by version (then name as tiebreaker for duplicate-version files).
  // All filenames are 3-digit padded so lexicographic = numeric order;
  // letter-suffix ordering (244 < 244b) is preserved.
  const sorted = [...files].sort((a, b) => {
    if (a.version !== b.version) return a.version < b.version ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  for (const file of sorted) {
    const prior = appliedByName.get(file.name);
    if (!prior) {
      toApply.push(file);
      continue;
    }
    if (prior.checksum === null) {
      // Legacy tracking row without checksum — trust file and record checksum.
      checksumBackfills.push(file);
    } else if (prior.checksum !== file.checksum) {
      conflicts.push({
        version: file.version,
        name: file.name,
        fileChecksum: file.checksum,
        dbChecksum: prior.checksum,
      });
    } else {
      skipped.push(file);
    }
  }

  return { toApply, skipped, checksumBackfills, conflicts };
}

function loadMigrationFiles(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return entries.map((name) => {
    const content = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    return {
      version: parseVersionFromFilename(name),
      name,
      content,
      checksum: computeChecksum(content),
    };
  });
}

async function fetchApplied(client: pg.PoolClient): Promise<TrackingRow[]> {
  const res = await client.query<TrackingRow>(
    'SELECT version, name, checksum FROM schema_migrations'
  );
  return res.rows;
}

async function applyOne(client: pg.PoolClient, file: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(file.content);
    await client.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, checksum = EXCLUDED.checksum, applied_at = now()`,
      [file.version, file.name, file.checksum]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function backfillOne(client: pg.PoolClient, file: MigrationFile): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
    [file.version, file.name, file.checksum]
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const backfill = process.argv.includes('--backfill');

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Strip Neon pooler + channel_binding for stable session connection (mirrors src/lib/neon.ts getDirectUrl).
  const directUrl = url
    .replace('-pooler.', '.')
    .replace('&channel_binding=require', '')
    .replace('?channel_binding=require', '?');

  const pool = new pg.Pool({
    connectionString: directUrl,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  // See scripts/migrationNoticeListener.ts: without a listener node-postgres
  // discards every RAISE WARNING / RAISE NOTICE a migration emits.
  const noticeListener = makeNoticeListener();
  client.on('notice', noticeListener);
  try {
    // Bootstrap: ensure tracking table exists with canonical schema even if
    // migration 332 hasn't run yet. Also upgrades pre-existing tables that
    // only had (filename, applied_at) columns from prior ad-hoc tooling.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         version text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now(),
         checksum text
       )`
    );
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'schema_migrations' AND column_name = 'filename'
        ) THEN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='name') THEN
            ALTER TABLE schema_migrations ADD COLUMN name text;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='version') THEN
            ALTER TABLE schema_migrations ADD COLUMN version text;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum') THEN
            ALTER TABLE schema_migrations ADD COLUMN checksum text;
          END IF;
          UPDATE schema_migrations
             SET name = COALESCE(name, filename),
                 version = COALESCE(version, substring(filename FROM '^(\\d+[a-z]?)_'));
          ALTER TABLE schema_migrations ALTER COLUMN name SET NOT NULL;
          ALTER TABLE schema_migrations ALTER COLUMN version SET NOT NULL;
          -- Migrate identity from legacy filename column to name:
          -- 1. add UNIQUE on name, 2. drop legacy filename PK/column.
          IF NOT EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename = 'schema_migrations' AND indexname = 'schema_migrations_name_key'
          ) THEN
            ALTER TABLE schema_migrations ADD CONSTRAINT schema_migrations_name_key UNIQUE (name);
          END IF;
          ALTER TABLE schema_migrations DROP COLUMN filename CASCADE;
        END IF;
      END $$;
    `);

    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    try {
      const files = loadMigrationFiles();
      const applied = await fetchApplied(client);
      const plan = planApply(files, applied);

      console.log(`Found ${files.length} migration files, ${applied.length} already tracked`);
      console.log(`  toApply:           ${plan.toApply.map((f) => f.version).join(', ') || '(none)'}`);
      console.log(`  skipped:           ${plan.skipped.length} file(s)`);
      console.log(`  checksumBackfills: ${plan.checksumBackfills.length} file(s)`);
      console.log(`  conflicts:         ${plan.conflicts.map((c) => c.version).join(', ') || '(none)'}`);

      if (plan.conflicts.length > 0) {
        console.error('Checksum conflicts — migration files edited after apply:');
        for (const c of plan.conflicts) {
          console.error(`  ${c.name}  file=${c.fileChecksum.slice(0, 8)}  db=${(c.dbChecksum ?? 'null').slice(0, 8)}`);
        }
        process.exit(2);
      }

      if (dryRun) {
        console.log('--dry-run: no changes made');
        return;
      }

      // Always record checksums for legacy rows that are missing them.
      for (const file of plan.checksumBackfills) {
        await client.query(
          `UPDATE schema_migrations SET checksum = $1, version = $2 WHERE name = $3`,
          [file.checksum, file.version, file.name]
        );
      }
      if (plan.checksumBackfills.length > 0) {
        console.log(`Recorded checksums for ${plan.checksumBackfills.length} legacy rows`);
      }

      if (backfill) {
        for (const file of plan.toApply) {
          await backfillOne(client, file);
          console.log(`backfilled ${file.name}`);
        }
        console.log(`Backfill complete: ${plan.toApply.length} rows`);
        return;
      }

      for (const file of plan.toApply) {
        console.log(`applying ${file.name} ...`);
        const t0 = Date.now();
        await applyOne(client, file);
        console.log(`  ok (${Date.now() - t0}ms)`);
      }
      console.log(`Applied ${plan.toApply.length} migrations`);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    // Review L6. The client goes back to the pool, so the listener would
    // outlive this call if main() were ever driven more than once.
    client.removeListener('notice', noticeListener);
    client.release();
    await pool.end();
  }
}

// Only run main when invoked directly, not when imported by tests.
// `import.meta.main` is a Bun extension; cast to avoid tsc complaints since
// tests transitively pull this file into the type-check graph.
if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
