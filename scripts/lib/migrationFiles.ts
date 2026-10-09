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

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
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
