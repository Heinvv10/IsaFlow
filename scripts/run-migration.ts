/**
 * Run SQL migration using Neon serverless driver
 * Usage: bun run scripts/run-migration.ts scripts/migrations/sql/220_multi_company_scoping.sql
 */
import { neon } from '@neondatabase/serverless';
import * as fs from 'node:fs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: bun run scripts/run-migration.ts <path-to-sql-file>');
  process.exit(1);
}

const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
const sql = neon(DATABASE_URL);

async function run() {
  console.log(`Running migration: ${sqlFile}`);
  console.log('Connecting to database...');

  // Split SQL into individual statements, handling $$ dollar-quoted blocks
  const statements: string[] = [];
  let current = '';
  let inDollarQuote = false;
  let inStatement = false;

  for (const line of sqlContent.split('\n')) {
    const trimmed = line.trim();

    // Skip pure comment/empty lines only when NOT in the middle of a statement
    if (!inStatement && !inDollarQuote && (trimmed.startsWith('--') || trimmed === '')) {
      continue;
    }

    // Track dollar-quoted blocks (CREATE FUNCTION bodies)
    if (trimmed.includes('$$')) {
      const count = (line.match(/\$\$/g) || []).length;
      if (count % 2 === 1) inDollarQuote = !inDollarQuote;
    }

    current += line + '\n';
    inStatement = true;

    // If we hit a semicolon at the end and we're not in a dollar-quoted block
    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt && stmt !== ';' && stmt !== 'BEGIN;' && stmt !== 'COMMIT;') {
        // Remove leading comment-only lines from the statement
        const cleaned = stmt.replace(/^(--[^\n]*\n)+/, '').trim();
        if (cleaned) statements.push(cleaned);
      }
      current = '';
      inStatement = false;
    }
  }

  console.log(`Found ${statements.length} statements to execute`);

  let success = 0;
  let errors = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.substring(0, 80).replace(/\n/g, ' ');
    try {
      await sql.query(stmt, []);
      success++;
      console.log(`  [${i + 1}/${statements.length}] OK: ${preview}...`);
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [${i + 1}/${statements.length}] FAIL: ${preview}...`);
      console.error(`    Error: ${message}`);
    }
  }

  console.log(`\nMigration complete: ${success} succeeded, ${errors} failed out of ${statements.length} statements`);
}

run();
