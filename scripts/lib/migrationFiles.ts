/**
 * Migration-file primitives shared by scripts/apply-migrations.ts (the runner)
 * and scripts/check-migration-parity.ts (the pre-deploy gate): file discovery,
 * checksum, and the apply-one-file-in-a-transaction step. One definition of
 * each, so the gate can never disagree with the runner about what a file is.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type pg from 'pg';

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

export const MIGRATIONS_DIR = join(process.cwd(), 'scripts', 'migrations', 'sql');

export function parseVersionFromFilename(filename: string): string {
  // Digits, then none, one or two lowercase letters ("244b_...", "999za_..."):
  // after 999z_ comes 999za_ ... 999zz_.
  const match = /^(\d+[a-z]{0,2})_/.exec(filename);
  if (!match) {
    throw new Error(`Migration filename missing numeric prefix: ${filename}`);
  }
  return match[1]!;
}

/**
 * The one migration order (runner, parity gate, file loader): the version's
 * digits as an integer, then its letters as a string (none < a < az < b < z <
 * za < zz), then the filename for duplicate versions. Numeric, so 1000_ follows 999b_ instead of preceding
 * 100_ as a string sort would. refresh-baseline.sh has the bash equivalent.
 */
export function compareMigrations(a: { version: string; name: string }, b: { version: string; name: string }): number {
  const va = /^(\d+)([a-z]{0,2})$/.exec(a.version);
  const vb = /^(\d+)([a-z]{0,2})$/.exec(b.version);
  if (va && vb) {
    const byNumber = parseInt(va[1]!, 10) - parseInt(vb[1]!, 10);
    if (byNumber !== 0) return byNumber;
    if (va[2] !== vb[2]) return va[2]! < vb[2]! ? -1 : 1;
  }
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** compareMigrations over bare filenames. */
export function compareMigrationNames(a: string, b: string): number {
  return compareMigrations(
    { version: parseVersionFromFilename(a), name: a },
    { version: parseVersionFromFilename(b), name: b },
  );
}

/** Strip Neon pooler + channel_binding for a stable session connection (mirrors src/lib/neon.ts getDirectUrl). */
export function toDirectUrl(url: string): string {
  return url
    .replace('-pooler.', '.')
    .replace('&channel_binding=require', '')
    .replace('?channel_binding=require', '?');
}

export function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(compareMigrationNames);
  return entries.map((name) => {
    const content = readFileSync(join(dir, name), 'utf8');
    return {
      version: parseVersionFromFilename(name),
      name,
      content,
      checksum: computeChecksum(content),
    };
  });
}

/** Apply one file and record its tracking row in the SAME transaction. */
export async function applyOne(client: pg.ClientBase, file: MigrationFile): Promise<void> {
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

/**
 * S-07b (migration 915): make app_service's policies exactly those app_user's
 * policies call for (create missing, drop extra). The runner calls it after
 * every run and the parity gate after any dev apply, so a table a migration
 * applied after 915 adds or changes (whatever its number) is covered on the
 * same run. Returns how many policies it changed, or null before 915 is
 * applied.
 */
export async function syncAppServicePolicies(client: pg.ClientBase): Promise<number | null> {
  const fn = await client.query<{ f: string | null }>(`SELECT to_regprocedure('public.app_service_sync_policies()')::text AS f`);
  if (!fn.rows[0]?.f) return null;
  const r = await client.query<{ n: number }>('SELECT public.app_service_sync_policies() AS n');
  return r.rows[0]?.n ?? 0;
}
