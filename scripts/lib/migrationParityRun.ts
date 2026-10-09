/**
 * IO half of the pre-deploy migration-parity gate (the pure rules live in
 * ./migrationParity). Kept separate from the CLI so tests can drive it against
 * two disposable databases.
 *
 * Safety properties (each pinned by tests/integration/migration-parity-gate.int.test.ts):
 *  - prod: SET default_transaction_read_only + BEGIN READ ONLY, one SELECT, never reused for dev.
 *  - identity: prod must be `isaflow` with rows; dev must be `isaflow_dev`; they must not be the same cluster+db
 *    (pg_control_system().system_identifier, or server addr+port when the role may not call it).
 *  - --apply-dev: advisory lock (the runner's key) held while reading and applying; capped at MAX_DEV_APPLY files.
 * DB URLs are never printed.
 */
import pg from 'pg';
import { makeNoticeListener } from '../migrationNoticeListener';
import { applyOne, toDirectUrl, type MigrationFile } from './migrationFiles';
import {
  classifyMigrationParity,
  hasOwnCommit,
  type ParityFinding,
  type ParityResult,
  type ParityRow,
} from './migrationParity';

/** Same key as scripts/apply-migrations.ts, so the two never apply concurrently. */
export const ADVISORY_LOCK_KEY = 73014132;
export const MAX_DEV_APPLY = 10;
/** Bound on one migration while holding the shared lock and the deploy flock. */
export const APPLY_STATEMENT_TIMEOUT_MS = 15 * 60_000;

export interface ParityRunOptions {
  devUrl: string;
  prodUrl: string;
  files: MigrationFile[];
  applyDev: boolean;
  verbose?: boolean;
  /** Required database names. Overridable only so tests can provoke the refusals. */
  expect?: { dev: string; prod: string };
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  say?: (line: string) => void;
  warn?: (line: string) => void;
}

interface Identity {
  db: string;
  /** `sysid:<system_identifier>` or, when pg_control_system is not permitted, `addr:<addr>:<port>`. */
  cluster: string;
}

function connect(url: string, o: ParityRunOptions): pg.Client {
  return new pg.Client({
    connectionString: toDirectUrl(url),
    ...(url.includes('sslmode=disable') ? {} : { ssl: { rejectUnauthorized: false } }),
    connectionTimeoutMillis: o.connectTimeoutMs ?? 10_000,
    statement_timeout: o.statementTimeoutMs ?? 60_000,
  });
}

async function identity(c: pg.Client, say: (l: string) => void, label: string): Promise<Identity> {
  const base = await c.query<{ db: string; addr: string | null; port: number | null }>(
    'SELECT current_database() AS db, inet_server_addr()::text AS addr, inet_server_port() AS port'
  );
  const { db, addr, port } = base.rows[0]!;
  try {
    const res = await c.query<{ sid: string }>('SELECT system_identifier::text AS sid FROM pg_control_system()');
    return { db, cluster: `sysid:${res.rows[0]!.sid}` };
  } catch (err) {
    say(`note: ${label} role cannot call pg_control_system() (${err instanceof Error ? err.message : String(err)}); comparing server addr+port instead`);
    return { db, cluster: `addr:${addr}:${port}` };
  }
}

async function fetchRows(c: pg.Client): Promise<ParityRow[]> {
  return (await c.query<ParityRow>('SELECT name, checksum FROM schema_migrations')).rows;
}

async function readProd(o: ParityRunOptions, want: string, say: (l: string) => void): Promise<{ id: Identity; rows: ParityRow[] }> {
  const prod = connect(o.prodUrl, o);
  await prod.connect();
  try {
    await prod.query('SET default_transaction_read_only = on');
    const id = await identity(prod, say, 'prod'); // before BEGIN: a refused pg_control_system() would abort the transaction
    if (id.db !== want) throw new Error(`prod URL names database "${id.db}", expected "${want}"; refusing`);
    await prod.query('BEGIN READ ONLY');
    const rows = await fetchRows(prod);
    await prod.query('COMMIT'); // read-only transaction: nothing to persist
    if (rows.length === 0) throw new Error('prod schema_migrations is empty; refusing (wrong database?)');
    return { id, rows };
  } finally {
    await prod.end();
  }
}

function printFindings(result: ParityResult, say: (l: string) => void): void {
  say('\nRULE                          SEVERITY  MIGRATION');
  for (const f of result.findings) {
    say(`${f.rule.padEnd(29)} ${f.severity.padEnd(9)} ${f.name}`);
    say(`                              ${f.detail}`);
  }
}

function printFixes(failures: ParityFinding[], warn: (l: string) => void): void {
  if (failures.length === 0) return;
  warn('\nFix commands (DEV_DATABASE_URL = your isaflow_dev URL; nothing was changed for these):');
  for (const f of failures) {
    warn(`\n# ${f.rule} ${f.name}`);
    for (const cmd of f.fixes) warn(cmd);
  }
}

async function applyMissing(dev: pg.Client, files: MigrationFile[], names: string[], say: (l: string) => void): Promise<string | null> {
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const name of names) {
    say(`applying ${name} to dev ...`);
    try {
      await applyOne(dev, byName.get(name)!);
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

/** Returns the process exit code (0 pass, 1 blocking findings). Throws on refusals and connection errors. */
export async function runParityGate(o: ParityRunOptions): Promise<number> {
  const say = o.say ?? ((l: string) => console.log(l));
  const warn = o.warn ?? ((l: string) => console.error(l));
  const want = o.expect ?? { dev: 'isaflow_dev', prod: 'isaflow' };

  const prod = await readProd(o, want.prod, say);

  const dev = connect(o.devUrl, o);
  await dev.connect();
  dev.on('notice', makeNoticeListener());
  let locked = false;
  try {
    const devId = await identity(dev, say, 'dev');
    if (devId.db !== want.dev) throw new Error(`DATABASE_URL names database "${devId.db}", expected "${want.dev}"; refusing to treat it as dev`);
    if (devId.db === prod.id.db && devId.cluster === prod.id.cluster) {
      throw new Error('dev and prod connections resolve to the same cluster and database; refusing');
    }

    if (o.applyDev) {
      try {
        await dev.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      } catch (err) {
        throw new Error(
          `could not take advisory lock ${ADVISORY_LOCK_KEY} on dev: another migration runner (bun run db:migrate or a second deploy) probably holds it. Wait for it or find it in pg_locks, then re-run. (${err instanceof Error ? err.message : String(err)})`
        );
      }
      locked = true;
    }
    const devRows = await fetchRows(dev);
    const result = classifyMigrationParity(o.files, devRows, prod.rows, { applyDev: o.applyDev });

    const prodNames = new Set(prod.rows.map((r) => r.name));
    const pending = o.files.filter((f) => !prodNames.has(f.name)).map((f) => f.name);
    say(`migration parity: dev=${devId.db}, ${o.files.length} files, ${prod.rows.length} tracked on prod`);
    say(`pending for prod (${pending.length}): ${pending.slice(0, 10).join(', ') || '(none)'}`);
    if (result.ignoredHistoric > 0) {
      say(`${result.ignoredHistoric} historic migration(s) are on prod but untracked on dev (frozen list, ignored)`);
      if (o.verbose) for (const n of result.ignoredNames) say(`  ignored: ${n}`);
    }
    if (result.ignoredOrphans > 0) say(`${result.ignoredOrphans} historic prod row(s) have no repo file (renamed/deleted long ago, allowlisted)`);
    if (result.prodNullChecksums > 0) say(`${result.prodNullChecksums} prod row(s) have a NULL checksum (legacy; never counted as a mismatch)`);
    if (result.findings.length === 0) say('PASS: no findings');
    else printFindings(result, say);

    if (o.applyDev && result.ok && result.devMissing.length > 0) {
      if (result.devMissing.length > MAX_DEV_APPLY) {
        throw new Error(
          `${result.devMissing.length} migrations would be applied to dev (cap ${MAX_DEV_APPLY}); that many usually means the prod read or the repo is wrong, not that dev is that far behind. If dev really is that far behind, apply them deliberately (psql -1 -f per file, or bun scripts/apply-migrations.ts against dev) and re-run; the cap is MAX_DEV_APPLY in scripts/lib/migrationParityRun.ts. Refusing.`
        );
      }
      const byName = new Map(o.files.map((f) => [f.name, f]));
      for (const name of result.devMissing) {
        if (hasOwnCommit(byName.get(name)!.content)) {
          warn(`WARNING: ${name} contains its own COMMIT; a failure part-way cannot be rolled back atomically on dev`);
        }
      }
      // A real migration may outlast the 60s read timeout, but must not hold the lock and the deploy flock forever.
      await dev.query(`SET statement_timeout = ${APPLY_STATEMENT_TIMEOUT_MS}`);
      const error = await applyMissing(dev, o.files, result.devMissing, say);
      if (error) {
        warn(`\nFAIL: dev failed applying ${error}`);
        return 1;
      }
      say(`applied ${result.devMissing.length} migration(s) to dev`);
    }

    const failures = result.findings.filter((f) => f.severity === 'FAIL');
    printFixes(failures, warn);
    if (failures.length > 0) {
      warn(`\nFAIL: ${failures.length} blocking finding(s); deploy aborted`);
      return 1;
    }
    return 0;
  } finally {
    try {
      if (locked) await dev.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch (unlockErr) {
      // Keep the original error/result; ending the session releases the lock anyway.
      warn(`WARNING: could not unlock advisory lock ${ADVISORY_LOCK_KEY}: ${unlockErr instanceof Error ? unlockErr.message : String(unlockErr)}`);
    } finally {
      await dev.end();
    }
  }
}
