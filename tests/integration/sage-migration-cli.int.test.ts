/**
 * scripts/sage-migration/run.ts as a person runs it (bun, a child process) against the throwaway database: a dry run writes
 * nothing, --live books the export and writes the report file, a second --live run adds nothing, and the expectations
 * (--expect-items / --expect-pos / --expect-po-total) are compared with the export. The refusals of the start (a database that
 * is not local and throwaway, a company that is not the user's) are in the unit suite and the runner suite.
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { migrationLockKey } from '@/modules/accounting/services/sage-migration/sageRunLock';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { booked, cleanupSageWorld, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let s: SageWorld;
let dir: string;

beforeAll(async () => { s = await sageWorld(pool); dir = mkdtempSync(join(tmpdir(), 'sage-cli-')); }, 120_000);
afterAll(async () => {
  try { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); } finally { rmSync(dir, { recursive: true, force: true }); await pool.end(); }
}, 120_000);

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync('bun', ['--no-env-file', 'scripts/sage-migration/run.ts', ...args], {
    encoding: 'utf8', timeout: 170_000,
    env: { ...process.env, DATABASE_SSL: 'disable', ...env }, // the gate's own clean environment (run.sh env -i)
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const base = () => ['--company', s.companyId, '--user', s.userId, '--file', 'tests/fixtures/sage-export/sage-export.json'];

describe('scripts/sage-migration/run.ts', () => {
  it('without --live it is a dry run: exit 0, a summary, nothing written', async () => {
    const r = cli(base());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`company ${s.companyId}: dry_run_ok`);
    expect(r.out).toContain('items: 20 in export, 0 refused, 20 sent, 0 already there, 0 there after (+0)');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0 });
  }, 180_000);

  it('--live books the export, compares the expectations and writes the report file', async () => {
    const total = parsedExport().exportPoTotalCents;
    const report = join(dir, 'report.json');
    const r = cli([...base(), '--live', '--report', report, '--expect-items', '20', '--expect-pos', '10', '--expect-po-total', (total / 100).toFixed(2)]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('completed');
    expect(r.out).toContain('all sent rows booked: true; nothing refused: true');
    expect(r.out).not.toContain('MISMATCH');
    expect(await booked(pool, s.companyId)).toMatchObject({ items: 20, categories: 4, pos: 10, movements: 0 });
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json).toMatchObject({ status: 'completed', reconciliation: { allSentBooked: true, nothingRefused: true, purchaseOrders: { differenceCents: 0 } } });
  }, 180_000);

  it('a second --live run adds nothing; a wrong expectation is a MISMATCH and exit 1', async () => {
    const before = await booked(pool, s.companyId);
    const r = cli([...base(), '--live', '--expect-items', '20', '--expect-pos', '757']);
    expect(r.code).toBe(1); // the export has 10 POs, not the 757 asked for: the dry run shows it and live is NOT started
    expect(r.out).toContain('company ' + s.companyId + ': live_blocked');
    expect(r.out).toContain('MISMATCH purchaseOrders: expected 757, sent 10');
    expect(r.out).toContain('LIVE NOT STARTED: --expect-pos 757, but the dry run would send 10');
    expect(await booked(pool, s.companyId)).toEqual(before);
  }, 180_000);

  it('a refused row is exit 1, dry run or live, unless --allow-refusals; the rest of the file is still booked', async () => {
    const file = JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
    file.Items.$resources[2].TaxTypeIdSales = 9; // FIB-0003 cannot be read
    const bad = join(dir, 'refused.json');
    writeFileSync(bad, JSON.stringify(file));
    for (const name of ['Alpha Optics (Pty) Ltd', 'Bravo Poles CC', 'Charlie Tools']) await pool.query('INSERT INTO suppliers (company_id, name) VALUES ($1, $2)', [s.otherCompanyId, name]);
    const args = ['--company', s.otherCompanyId, '--user', s.otherUserId, '--file', bad];
    const dry = cli(args);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('refused item FIB-0003 [invalid_row]');
    expect(cli([...args, '--allow-refusals']).code).toBe(0);
    expect(await booked(pool, s.otherCompanyId)).toMatchObject({ items: 0, pos: 0 });
    // #3: without --allow-refusals live is NOT started, so nothing is committed and then reported as a failure.
    const live = cli([...args, '--live', '--expect-items', '19', '--expect-pos', '10']);
    expect(live.code).toBe(1);
    expect(live.out).toContain('LIVE NOT STARTED: rows are refused');
    expect(await booked(pool, s.otherCompanyId)).toMatchObject({ items: 0, pos: 0, categories: 0 });
    const allowed = cli([...args, '--live', '--allow-refusals', '--expect-items', '19', '--expect-pos', '10']);
    expect(allowed.code, allowed.out + allowed.err).toBe(0);
    expect(allowed.out).toContain('all sent rows booked: true; nothing refused: false');
    expect(await booked(pool, s.otherCompanyId)).toMatchObject({ items: 19, pos: 10 });
  }, 180_000);

  it('M2: a re-run whose Sage data changed is exit 1 with the difference listed, and 0 with --allow-differences', async () => {
    const file = JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
    file.PurchaseOrders[0].Status = 'Invoiced';
    const changed = join(dir, 'changed.json');
    writeFileSync(changed, JSON.stringify(file));
    const args = ['--company', s.companyId, '--user', s.userId, '--file', changed, '--live', '--expect-items', '20', '--expect-pos', '10'];
    const r = cli(args);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/DIFFERS: PO0000197 .*status approved -> closed/);
    expect(r.out).toContain('LIVE NOT STARTED');
    const okd = cli([...args, '--allow-differences']);
    expect(okd.code, okd.out + okd.err).toBe(0);
  }, 180_000);

  it('#3: --expect-pos 3 on a good file, and a partly refused file without --allow-refusals: both exit 1 with nothing written', async () => {
    const world = await sageWorld(pool);
    try {
      const good = ['--company', world.companyId, '--user', world.userId, '--file', 'tests/fixtures/sage-export/sage-export.json', '--live'];
      const r = cli([...good, '--expect-items', '20', '--expect-pos', '3']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('LIVE NOT STARTED: --expect-pos 3, but the dry run would send 10');
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0, toolCalls: 0 });
      const file = JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'));
      file.PurchaseOrders[1].SupplierId = 999;
      file.PurchaseOrders[1].SupplierName = 'Nobody Ltd';
      const part = join(dir, 'part.json');
      writeFileSync(part, JSON.stringify(file));
      const p = cli(['--company', world.companyId, '--user', world.userId, '--file', part, '--live', '--expect-items', '20', '--expect-pos', '9']);
      expect(p.code).toBe(1);
      expect(p.out).toContain('LIVE NOT STARTED: rows are refused');
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0, toolCalls: 0 });
    } finally {
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('#4: a --report that cannot be written after a committed run: the summary is still printed, exit 3 (not 2), the books are as the run left them', async () => {
    const world = await sageWorld(pool);
    try {
      const r = cli(['--company', world.companyId, '--user', world.userId, '--file', 'tests/fixtures/sage-export/sage-export.json', '--live',
        '--expect-items', '20', '--expect-pos', '10', '--report', join(dir, 'no-such-dir', 'report.json')]);
      expect(r.code).toBe(3);
      expect(r.out).toContain(`company ${world.companyId}: completed`);
      expect(r.out).toContain('all sent rows booked: true; nothing refused: true');
      expect(r.err).toMatch(/the run finished \(exit 0 without this\) but the report could not be written to .*no-such-dir.*ENOENT/);
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 20, pos: 10 });
    } finally {
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('R2 (round 4): while another run holds the company the CLI is refused at its start: exit 2, the message, nothing written', async () => {
    const world = await sageWorld(pool);
    const holder = await pool.connect();
    const [k1, k2] = migrationLockKey(world.companyId);
    try {
      await holder.query('SELECT pg_advisory_lock($1, $2)', [k1, k2]);
      const r = cli(['--company', world.companyId, '--user', world.userId, '--file', 'tests/fixtures/sage-export/sage-export.json']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/another Sage migration is running for this company/);
      expect(r.out).toBe('');
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 0, pos: 0, toolCalls: 0 });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      holder.release();
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('M1 (round 5): a run that stops after its live phase started (its lock lost after the first batch) is exit 4, not 2, and lists what it committed', async () => {
    const world = await sageWorld(pool);
    try {
      const r = spawnSync('bun', ['--no-env-file', '--preload', join(process.cwd(), 'tests/integration/helpers/sageKillLockPreload.ts'),
        'scripts/sage-migration/run.ts', '--company', world.companyId, '--user', world.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
        '--live', '--expect-items', '20', '--expect-pos', '10'], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', SAGE_KILL_AFTER_COMMIT: '1' } });
      expect(r.status).toBe(4);
      expect(r.stderr).toMatch(/sage migration stopped: lock lost/);
      expect(r.stderr).toMatch(/the live run may already have committed some batches/);
      expect(r.stderr).toMatch(/committed: category batch 1/);
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 0, pos: 0 }); // stopped at the next boundary, before the items
    } finally {
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('B6-A2 (round 6): a second identical --live run of a file with a discounted line exits 0 (a re-run resumes, it does not fail on a false difference)', async () => {
    const world = await sageWorld(pool);
    try {
      const f = JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8')) as { PurchaseOrders: Array<Record<string, unknown>> };
      const lines = f.PurchaseOrders[0]!.Lines as Array<Record<string, unknown>>;
      lines[1] = { ...lines[1], UnitPriceExclusive: 400 }; // list price 400 less 12.5%: Exclusive stays 350
      const file = join(dir, 'discount.json');
      writeFileSync(file, JSON.stringify(f));
      const args = ['--company', world.companyId, '--user', world.userId, '--file', file, '--live', '--expect-items', '20', '--expect-pos', '10'];
      expect(cli(args).code).toBe(0);
      const two = cli(args);
      expect(two.code).toBe(0);
      expect(two.out).not.toContain('DIFFERS');
      expect(two.out).not.toContain('LIVE NOT STARTED');
    } finally {
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('L1 (round 6): a lock lost BEFORE the live phase (after the dry run) is exit 2, a refused start: nothing about commits, nothing written', async () => {
    const world = await sageWorld(pool);
    try {
      const r = spawnSync('bun', ['--no-env-file', '--preload', join(process.cwd(), 'tests/integration/helpers/sageKillLockPreload.ts'),
        'scripts/sage-migration/run.ts', '--company', world.companyId, '--user', world.userId, '--file', 'tests/fixtures/sage-export/sage-export.json',
        '--live', '--expect-items', '20', '--expect-pos', '10'], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', SAGE_KILL_AFTER_ROLLBACK: '2' } });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/sage migration stopped: lock lost/);
      expect(r.stderr).not.toMatch(/may already have committed/);
      expect(await booked(pool, world.companyId)).toMatchObject({ items: 0, categories: 0, pos: 0 });
    } finally {
      await cleanupSageWorld(pool, world);
      await cleanupWorld(pool, world.w);
    }
  }, 180_000);

  it('F4: --live needs --expect-items and --expect-pos, so a file that lost a container cannot pass unnoticed', () => {
    const live = [...base(), '--live'];
    expect(cli(live).code).toBe(2);
    expect(cli(live).err).toMatch(/--live needs --expect-items and --expect-pos/);
    expect(cli([...live, '--expect-items', '20']).code).toBe(2);
    expect(cli([...live, '--expect-pos', '10']).code).toBe(2);
  }, 180_000);

  it('F4: an export with a misspelt container or no container is refused (exit 2) before anything runs', () => {
    const a = join(dir, 'misspelt.json');
    writeFileSync(a, JSON.stringify({ Items: [], Purchase_Orders: [] }));
    expect(cli(['--company', s.companyId, '--user', s.userId, '--file', a])).toMatchObject({ code: 2 });
    expect(cli(['--company', s.companyId, '--user', s.userId, '--file', a]).err).toMatch(/unknown key "Purchase_Orders"/);
    const b = join(dir, 'empty.json');
    writeFileSync(b, '{}');
    expect(cli(['--company', s.companyId, '--user', s.userId, '--file', b]).err).toMatch(/neither Items nor PurchaseOrders/);
  }, 180_000);

  it('refuses to start (exit 2) on a database that is not a local throwaway one, before touching it', () => {
    for (const url of ['postgresql://postgres@127.0.0.1:7772/isaflow_dev', 'postgresql://postgres@100.96.203.105:5432/isaflow', undefined]) {
      const r = cli(base(), { DATABASE_URL: url });
      expect(r.code, String(url)).toBe(2);
      expect(r.err).toMatch(/Refusing to run the Sage migration: DATABASE_URL/);
      expect(r.out).toBe('');
    }
  }, 180_000);

  it('refuses a SERVICE_DATABASE_URL that is not local, and a missing or malformed company or user', () => {
    expect(cli(base(), { SERVICE_DATABASE_URL: 'postgresql://svc@100.96.203.105:7772/isaflow' }).err).toMatch(/SERVICE_DATABASE_URL/);
    expect(cli(['--user', s.userId, '--file', 'x']).code).toBe(2);
    expect(cli(['--company', 'nope', '--user', s.userId, '--file', 'x']).err).toMatch(/--company <uuid> is required/);
    expect(cli(['--company', s.companyId, '--file', 'x']).err).toMatch(/--user <uuid> is required/);
  }, 180_000);
});
