#!/usr/bin/env node
/**
 * Run a single SQL file against the database.
 * Usage: DATABASE_URL=... node scripts/run-sql.mjs <sql-file>
 */
import pg from 'pg';
import { readFileSync } from 'fs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/run-sql.mjs <sql-file>'); process.exit(1); }

const sql = readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString: DATABASE_URL });

await client.connect();
try {
  const result = await client.query(sql);
  // Show NOTICE messages
  if (Array.isArray(result)) {
    console.log('Done. Rows affected:', result.map(r => r.rowCount));
  } else {
    console.log('Done. Rows affected:', result.rowCount);
  }
} catch (err) {
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
