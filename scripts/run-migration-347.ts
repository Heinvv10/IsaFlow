/**
 * Runs migration 347 against the configured DATABASE_URL.
 * Idempotent: safe to re-run.
 */
import { createSql } from './_pg';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const sql = createSql();
const migrationFile = path.resolve(__dirname, 'migrations/sql/347_auto_posting_foundation.sql');
const content = fs.readFileSync(migrationFile, 'utf-8');
const checksum = createHash('sha256').update(content).digest('hex');
const version = '347';
const name = '347_auto_posting_foundation';

/**
 * Split a SQL file into top-level statements while respecting DO $$ … END $$ blocks.
 * Strategy: walk char-by-char. Track whether we're inside a $$ body. Split at ';'
 * only when not inside a body.
 */
function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let i = 0;
  while (i < sqlText.length) {
    const ch = sqlText[i];
    const next = sqlText[i + 1];
    // line comment
    if (!inDollar && ch === '-' && next === '-') {
      while (i < sqlText.length && sqlText[i] !== '\n') { buf += sqlText[i++]!; }
      continue;
    }
    // toggle $$ body
    if (ch === '$' && next === '$') {
      inDollar = !inDollar;
      buf += '$$';
      i += 2;
      continue;
    }
    if (!inDollar && ch === ';') {
      const trimmed = buf.trim();
      if (trimmed && !trimmed.split('\n').every(l => l.trim().startsWith('--') || !l.trim())) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

(async () => {
  const existing = (await sql`
    SELECT version, checksum FROM schema_migrations WHERE version = ${version}
  `) as Array<{ version: string; checksum: string }>;
  if (existing.length > 0) {
    if (existing[0]!.checksum !== checksum) {
      console.error(`Migration ${version} already applied with different checksum. Refusing to re-run.`);
      console.error(`  recorded: ${existing[0]!.checksum}`);
      console.error(`  current:  ${checksum}`);
      process.exit(1);
    }
    console.log(`Migration ${version} already applied (checksum match).`);
    return;
  }

  const stmts = splitStatements(content);
  console.log(`Running migration ${version} — ${stmts.length} statements`);

  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    const preview = s.slice(0, 80).replace(/\s+/g, ' ');
    console.log(`  [${i + 1}/${stmts.length}] ${preview}${s.length > 80 ? '…' : ''}`);
    try {
      await sql.query(s);
    } catch (err) {
      console.error(`Statement ${i + 1} failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  await sql`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (${version}, ${name}, ${checksum}, NOW())
    ON CONFLICT (version) DO NOTHING
  `;
  console.log(`\nMigration ${version} applied.`);

  const orph = (await sql`
    SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE fiscal_period_id IS NULL
  `) as Array<{ n: number }>;
  console.log(`Remaining JEs with NULL fiscal_period_id: ${orph[0]?.n}`);

  const accts = (await sql`
    SELECT account_code, COUNT(*)::int AS n FROM gl_accounts
    WHERE account_code IN ('2140', '2150', '2160', '2170') GROUP BY account_code ORDER BY account_code
  `) as Array<{ account_code: string; n: number }>;
  for (const a of accts) console.log(`  ${a.account_code} present in ${a.n} companies`);
})().catch(e => { console.error('ERR:', e instanceof Error ? e.message : e); process.exit(1); });
