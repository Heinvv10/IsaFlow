/**
 * Schema-drift audit — compares migration source of truth against the
 * live database.
 *
 * Motivation: the Supabase cutover silently dropped columns and tables
 * (companies.primary_color, app_settings, customer_categories, ...) that
 * downstream code still referenced. Most failures were swallowed by
 * defensive try/catch blocks, poisoning the withAuth request tx and
 * surfacing only as 500s far from the root cause. This audit makes the
 * drift loud.
 *
 * Fails with exit code 1 when any column or table declared in migrations
 * is missing from the live DB, so it can run in CI before deploy.
 *
 * Usage:
 *   bun scripts/audit-schema-drift.ts
 *   bun scripts/audit-schema-drift.ts --allow=table:*,other:col_name
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parseExpectedSchema } from './lib/schemaDriftParse';

async function fetchLiveSchema(): Promise<Map<string, Set<string>>> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'strict'
      ? { rejectUnauthorized: true }
      : process.env.DATABASE_SSL === 'disable'
        ? false
        : { rejectUnauthorized: false },
  });
  try {
    const res = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const db = new Map<string, Set<string>>();
    for (const row of res.rows as { table_name: string; column_name: string }[]) {
      if (!db.has(row.table_name)) db.set(row.table_name, new Set());
      db.get(row.table_name)!.add(row.column_name);
    }
    // Treat public views as valid table targets too. Views appear in
    // information_schema.columns already, but double-check to include
    // simple pass-through aliases that older migrations declared as tables.
    const viewRes = await pool.query(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`,
    );
    for (const row of viewRes.rows as { table_name: string }[]) {
      if (!db.has(row.table_name)) db.set(row.table_name, new Set());
    }
    return db;
  } finally {
    await pool.end();
  }
}

interface Allowlist {
  tables: Set<string>;
  columns: Set<string>;
}

function parseAllowlist(): Allowlist {
  const tables = new Set<string>();
  const columns = new Set<string>();

  // Pull the checked-in default first, then merge any ad-hoc additions
  // from env var / CLI so local overrides stack on top of the file.
  const sources: string[] = [];
  try {
    const raw = readFileSync('scripts/schema-drift-allowlist.txt', 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      sources.push(s);
    }
  } catch {
    // missing file is fine — treat as empty allowlist
  }

  const arg = process.argv.find(a => a.startsWith('--allow='));
  const inline = arg ? arg.slice('--allow='.length) : process.env.SCHEMA_DRIFT_ALLOW ?? '';
  for (const item of inline.split(',')) {
    if (item.trim()) sources.push(item.trim());
  }

  for (const raw of sources) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item.includes(':')) {
      const [t, c] = item.split(':');
      if (!t) continue;
      if (c === '*') tables.add(t);
      else if (c) columns.add(`${t}:${c}`);
    } else {
      tables.add(item);
    }
  }
  return { tables, columns };
}

(async () => {
  const expected = parseExpectedSchema();
  const allow = parseAllowlist();

  let live: Map<string, Set<string>>;
  try {
    live = await fetchLiveSchema();
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const missingTables: string[] = [];
  const missingCols: Array<{ table: string; col: string }> = [];

  for (const [table, cols] of expected) {
    if (allow.tables.has(table)) continue;
    const liveCols = live.get(table);
    if (!liveCols) {
      missingTables.push(table);
      continue;
    }
    for (const c of cols) {
      if (allow.columns.has(`${table}:${c}`)) continue;
      if (!liveCols.has(c)) missingCols.push({ table, col: c });
    }
  }

  const total = missingTables.length + missingCols.length;
  if (total === 0) {
    console.log(`schema-drift audit: OK (${expected.size} tables checked)`);
    process.exit(0);
  }

  console.error('schema-drift audit: DRIFT DETECTED\n');
  if (missingTables.length) {
    console.error(`Missing tables (${missingTables.length}):`);
    for (const t of missingTables.sort()) console.error(`  - ${t}`);
    console.error();
  }
  if (missingCols.length) {
    console.error(`Missing columns (${missingCols.length}):`);
    const byTable = new Map<string, string[]>();
    for (const { table, col } of missingCols) {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table)!.push(col);
    }
    for (const [t, cs] of [...byTable].sort()) {
      console.error(`  ${t}: ${cs.sort().join(', ')}`);
    }
    console.error();
  }

  console.error('To accept a known drift, add it to SCHEMA_DRIFT_ALLOW or --allow=');
  console.error('  --allow=table_name:*            (whole table)');
  console.error('  --allow=table_name:col_name     (single column)');
  console.error('  --allow=t1:c1,t2:*,t3:c3        (combine, comma-separated)');
  process.exit(1);
})();
