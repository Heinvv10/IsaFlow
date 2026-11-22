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
    expect(r.code).toBe(1); // the export has 10 POs, not the 757 asked for
    expect(r.out).toContain('items: 20 in export, 0 refused, 20 sent, 20 already there, 20 there after (+0)');
    expect(r.out).toContain('MISMATCH purchaseOrders: expected 757, booked 10');
    expect({ ...(await booked(pool, s.companyId)), toolCalls: 0 }).toEqual({ ...before, toolCalls: 0 });
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
    const live = cli([...args, '--live', '--expect-items', '19', '--expect-pos', '10']);
    expect(live.code).toBe(1);
    expect(live.out).toContain('all sent rows booked: true; nothing refused: false');
    expect(await booked(pool, s.otherCompanyId)).toMatchObject({ items: 19 });
    expect(cli([...args, '--live', '--allow-refusals', '--expect-items', '19', '--expect-pos', '10']).code).toBe(0);
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
    expect(cli([...args, '--allow-differences']).code).toBe(0);
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
