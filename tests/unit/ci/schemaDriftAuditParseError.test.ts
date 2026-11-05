/**
 * deploy.sh runs scripts/audit-schema-drift.ts after the migrations. schemaDriftParse throws on a CREATE TABLE it
 * cannot read (an unbalanced quote or parenthesis); the audit called it outside any try/catch, so the throw left
 * as an unhandled rejection with a stack trace. It must report `ERROR: <message>` and exit 2, as a live-schema
 * failure does. The script is run for real, in a throwaway directory whose scripts/migrations/sql holds the bad file
 * (the migration directory is relative to the working directory).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../scripts/audit-schema-drift.ts');
let dir: string;

function audit(sql: string, env: Record<string, string> = {}) {
  writeFileSync(join(dir, 'scripts/migrations/sql/001_t.sql'), sql);
  return spawnSync('bun', [SCRIPT], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    // A live URL that would fail fast: the parse must fail before it is ever used.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: 'postgresql://x@127.0.0.1:1/none', ...env },
  });
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'drift-audit-')); mkdirSync(join(dir, 'scripts/migrations/sql'), { recursive: true }); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('audit-schema-drift: a migration the parser cannot read', () => {
  it('prints ERROR: <message> and exits 2, with no stack trace', () => {
    const r = audit("CREATE TABLE bad_t (id uuid, note text DEFAULT 'oops);\n");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^ERROR: schemaDriftParse: unbalanced quote\/parenthesis in CREATE TABLE bad_t \(001_t\.sql\)/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stdout).toBe('');
  });

  it('an unclosed CREATE TABLE is reported the same way', () => {
    const r = audit('CREATE TABLE open_t (id uuid\n');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^ERROR: schemaDriftParse: a CREATE TABLE in 001_t\.sql could not be read/);
  });

  it('a readable migration still reaches the live-schema step (its failure is exit 2 too, with its own message)', () => {
    const r = audit('CREATE TABLE ok_t (id uuid);\n', { DATABASE_URL: '' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ERROR: DATABASE_URL is not set');
  });
});
