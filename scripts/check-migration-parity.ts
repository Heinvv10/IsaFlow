/**
 * Pre-deploy migration-parity gate. Run by scripts/deploy.sh BEFORE the CI gate.
 *
 *   bun scripts/check-migration-parity.ts [--apply-dev] [--prod-url-file <path>]
 *
 * Dev = DATABASE_URL (refused if it names the `isaflow` database).
 * Prod = PARITY_PROD_DATABASE_URL, or the first DATABASE_URL= line of
 *        --prod-url-file. Prod is opened READ ONLY and is never written.
 * --apply-dev applies PENDING migrations missing on dev, in order, one
 * transaction each, stopping at the first failure. Nothing else is auto-fixed.
 * Exit 0 only when no FAIL remains. DB URLs are never printed.
 */
import { readFileSync } from 'fs';
import pg from 'pg';
import { makeNoticeListener } from './migrationNoticeListener';
import { applyOne, loadMigrationFiles, type MigrationFile } from './lib/migrationFiles';
import {
  classifyMigrationParity,
  type ParityFinding,
  type ParityResult,
  type ParityRow,
} from './lib/migrationParity';

const PROD_DB_NAME = 'isaflow';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveProdUrl(): string {
  const fromEnv = process.env.PARITY_PROD_DATABASE_URL;
  if (fromEnv) return fromEnv;
  const file = argValue('--prod-url-file');
  if (file) {
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.slice('DATABASE_URL='.length);
  }
  throw new Error('prod URL missing: set PARITY_PROD_DATABASE_URL or pass --prod-url-file <file with DATABASE_URL=>');
}

function connect(url: string): pg.Client {
  return new pg.Client({ connectionString: url, ...(url.includes('sslmode=disable') ? {} : { ssl: { rejectUnauthorized: false } }) });
}

async function fetchRows(client: pg.Client): Promise<ParityRow[]> {
  const res = await client.query<ParityRow>('SELECT name, checksum FROM schema_migrations');
  return res.rows;
}

async function readProd(url: string): Promise<ParityRow[]> {
  const client = connect(url);
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query('BEGIN READ ONLY');
    const rows = await fetchRows(client);
    await client.query('ROLLBACK');
    return rows;
  } finally {
    await client.end();
  }
}

function printFindings(result: ParityResult): void {
  console.log('\nRULE           SEVERITY  MIGRATION');
  for (const f of result.findings) {
    console.log(`${f.rule.padEnd(14)} ${f.severity.padEnd(9)} ${f.name}`);
    console.log(`               ${f.detail}`);
  }
}

function printFixes(failures: ParityFinding[]): void {
  if (failures.length === 0) return;
  console.error('\nFix commands (DEV_DATABASE_URL = your isaflow_dev URL; nothing was changed for these):');
  for (const f of failures) {
    console.error(`\n# ${f.rule} ${f.name}`);
    for (const cmd of f.fixes) console.error(cmd);
  }
}

async function applyMissingToDev(dev: pg.Client, files: MigrationFile[], names: string[]): Promise<string | null> {
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const name of names) {
    console.log(`applying ${name} to dev ...`);
    try {
      await applyOne(dev, byName.get(name)!);
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

async function main(): Promise<number> {
  const applyDev = process.argv.includes('--apply-dev');
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error('DATABASE_URL (dev) not set');
  const prodUrl = resolveProdUrl();
  if (devUrl === prodUrl) throw new Error('dev and prod URLs are identical; refusing to run');

  const files = loadMigrationFiles();
  const prodRows = await readProd(prodUrl);

  const dev = connect(devUrl);
  await dev.connect();
  dev.on('notice', makeNoticeListener());
  try {
    const db = (await dev.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    if (db === PROD_DB_NAME) throw new Error(`DATABASE_URL points at the production database "${db}"; refusing to treat it as dev`);

    const devRows = await fetchRows(dev);
    const result = classifyMigrationParity(files, devRows, prodRows, { applyDev });
    const pending = files.length - files.filter((f) => prodRows.some((r) => r.name === f.name)).length;
    console.log(`migration parity: dev=${db}, ${files.length} files, ${pending} pending for prod, ${prodRows.length} tracked on prod`);
    if (result.ignoredHistoric > 0) {
      console.log(`${result.ignoredHistoric} old migration(s) are on prod but untracked on dev (historical gap, ignored)`);
    }
    if (result.findings.length === 0) console.log('PASS: no findings');
    else printFindings(result);

    let failures = result.findings.filter((f) => f.severity === 'FAIL');
    if (applyDev && failures.length === 0 && result.devMissing.length > 0) {
      const error = await applyMissingToDev(dev, files, result.devMissing);
      if (error) {
        console.error(`\nFAIL: applying to dev failed, prod would likely fail the same way:\n  ${error}`);
        return 1;
      }
      console.log(`applied ${result.devMissing.length} migration(s) to dev`);
    }
    failures = result.findings.filter((f) => f.severity === 'FAIL');
    printFixes(failures);
    if (failures.length > 0) {
      console.error(`\nFAIL: ${failures.length} blocking finding(s); deploy aborted`);
      return 1;
    }
    return 0;
  } finally {
    await dev.end();
  }
}

if ((import.meta as { main?: boolean }).main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`migration parity gate error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  );
}
