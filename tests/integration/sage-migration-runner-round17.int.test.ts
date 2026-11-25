/**
 * Round-14 breaker findings on a real database (b14-a probes B14-A1 and B14-A2, ported):
 *   - B14-1: a VAT-inclusive Sage PO whose lines carry no Tax is refused, never booked a cent off each way (header totals hid it, exit 0);
 *     the same PO with each line's own Exclusive and Tax is booked at exactly Sage's line figures;
 *   - B14-2: a re-run PO batch that wrote nothing (every PO there), one PO then deleted, is "answered ok, nothing new written" in the stop,
 *     never "committed" or "What the batch wrote was written";
 *   - B14-3 / R14-L1: the --report file: a mistyped option still replaces an earlier report; --report naming the export is refused; a
 *     run killed mid-live leaves "running".
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupWorld } from './helpers/itemsWorld';
import { afterCommitOf, cleanupSageWorld, exportFile, landedCommitPool, parsedExport, sageWorld, type SageWorld } from './helpers/sageMigrationWorld';
import { runSageMigration } from '@/modules/accounting/services/sage-migration/sageMigrationRunner';
import type { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor } from '@/modules/accounting/services/sage-migration/sageReportSummary';
import { exitCodeForError, stopMessage } from '@/modules/accounting/services/sage-migration/sageStopMessage';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let s: SageWorld;
beforeEach(async () => { s = await sageWorld(pool); }, 120_000);
afterEach(async () => { await cleanupSageWorld(pool, s); await cleanupWorld(pool, s.w); }, 120_000);

type Row = Record<string, unknown>;
const opts = (over: Row = {}) => ({ companyId: s.companyId, userId: s.userId, live: true, allowRefusals: true, allowDifferences: true, expect: { items: 20, purchaseOrders: 10 }, ...over });
const run = (over: Row = {}, p: Pool = pool, file: Row = exportFile()) => runSageMigration(p, parsedExport(file), opts(over));
const stopped = (p: Promise<unknown>) => p.then(() => { throw new Error('the run did not stop'); }, (e: unknown) => e as MigrationStopped);

/** Sage (inclusive document): line A R1.03 incl = 0.90 + 0.13, line B R1.19 incl = 1.03 + 0.16; PO 1.93 + 0.29 = 2.22. */
function inclusiveFile(withLineFigures: boolean): Row {
  const file = exportFile();
  const p0 = (file.PurchaseOrders as Row[])[0]!;
  const line = (unit: number, incl: number, ex: number, tax: number) => ({ Description: 'Probe', Quantity: 1, UnitPriceExclusive: unit, UnitPriceInclusive: incl, TaxTypeId: 1, TaxPercentage: 15,
    ...(withLineFigures ? { Exclusive: ex, Tax: tax, Total: Math.round((ex + tax) * 100) / 100 } : {}) });
  file.PurchaseOrders = [{ ID: 990101, DocumentNumber: 'B14-INCL-1', Date: '2026-03-01', Status: 'Pending', SupplierId: p0.SupplierId, SupplierName: p0.SupplierName,
    Inclusive: true, Exclusive: 1.93, Tax: 0.29, Total: 2.22, Lines: [line(0.895652, 1.03, 0.9, 0.13), line(1.034783, 1.19, 1.03, 0.16)] }];
  file.Items = [];
  return file;
}
const bookedLines = async () => (await pool.query(`SELECT (p.line_total + p.tax_amount)::FLOAT8 AS gross FROM po_items p JOIN purchase_orders o ON o.id = p.purchase_order_id
  WHERE o.company_id = $1 ORDER BY p.sort_order`, [s.companyId])).rows.map((x) => Number(x.gross));

describe('B14-1 (B14-A1): a VAT-inclusive Sage PO', () => {
  it('lines without their own Tax: the PO is refused, nothing booked (exit 1 strict)', async () => {
    const r = await run({ allowRefusals: false, allowDifferences: false, expect: { items: 0, purchaseOrders: 0 } }, pool, inclusiveFile(false));
    expect(r.refused.map((x) => [x.label, x.code])).toEqual([['B14-INCL-1', 'invalid_row']]);
    expect(r.refused[0]!.reasons.join(' ')).toMatch(/Lines\[0\] of a VAT-inclusive PO \(Inclusive true\) must give its own Exclusive and Tax/);
    expect(exitCodeFor(r, false, false)).toBe(1);
    expect(await bookedLines()).toEqual([]);
  });
  it('lines with their own Exclusive and Tax: booked at exactly Sage\'s line figures, exit 0', async () => {
    const r = await run({ allowRefusals: false, allowDifferences: false, expect: { items: 0, purchaseOrders: 1 } }, pool, inclusiveFile(true));
    expect(r.status).toBe('completed');
    expect(exitCodeFor(r, false, false)).toBe(0);
    expect(await bookedLines()).toEqual([1.03, 1.19]);
  });
});

describe('B14-2 (B14-A2): a re-run PO batch that wrote nothing, one of its POs then deleted, then a stop', () => {
  it('the stop says the batch wrote nothing, then names the PO; never "committed" or "What the batch wrote was written"', async () => {
    expect((await run({ poBatchSize: 4 })).status).toBe('completed');
    const ref = String((exportFile().PurchaseOrders as Row[])[0]!.ID);
    const del = async () => {
      await pool.query(`DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1 AND external_ref = $2)`, [s.companyId, ref]);
      await pool.query(`DELETE FROM purchase_orders WHERE company_id = $1 AND external_ref = $2`, [s.companyId, ref]);
    };
    // Re-run commits: 4 categories, 1 item batch, PO batch 1 (all there: created 0; the PO is deleted right after), PO batch 2 (lands, answer lost).
    const err = await stopped(run({ poBatchSize: 4 }, landedCommitPool(afterCommitOf(pool, 'bulk_create_purchase_orders', { after: del }), [7])));
    const m = stopMessage(err);
    const po1 = err.committed.find((b) => b.entity === 'purchase_order' && b.n === 1)!;
    expect(exitCodeForError(err)).toBe(4);
    expect(po1).toMatchObject({ allRowsAlreadyPresent: true, changedAfterCommit: true });
    expect(m).toMatch(/\nanswered ok, nothing new written \(its rows were already there\): purchase_order batch 1 \([^)]*\) \(then changed or removed in the books by another writer: PO\d+: check\)/);
    expect(m).not.toMatch(/\ncommitted: purchase_order batch 1 /);
    expect(po1.error ?? '').not.toMatch(/What the batch wrote was written|next phase/);
  });
});

describe('B14-3 / R14-L1 (round 14): the --report file', () => {
  const cli = (args: string[], env: Record<string, string> = {}, preload?: string) => spawnSync('bun', ['--no-env-file', ...(preload ? ['--preload', join(process.cwd(), preload)] : []),
    'scripts/sage-migration/run.ts', '--company', s.companyId, '--user', s.userId, ...args], { encoding: 'utf8', timeout: 170_000, env: { ...process.env, DATABASE_SSL: 'disable', ...env } });
  const FILE = 'tests/fixtures/sage-export/sage-export.json';
  it('a mistyped option (the strict parse throws): exit 2, stderr only; an existing --report is left, a new one never created (round 16)', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-r17-'));
    try {
      const report = join(d, 'report.json');
      writeFileSync(report, JSON.stringify({ status: 'completed', note: 'an earlier run' }));
      const r = cli(['--file', FILE, '--live', '--expect-items', '20', '--expect-po', '10', '--report', report]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Unknown option '--expect-po'/);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ status: 'completed', note: 'an earlier run' });
      const fresh = join(d, 'fresh.json');
      expect(cli(['--file', FILE, '--expect-po', '10', '--report', fresh]).status).toBe(2);
      expect(existsSync(fresh)).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 180_000);
  it('--report naming the export itself is refused (exit 2) and the export is left as it was', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-r17-'));
    try {
      const file = join(d, 'export.json');
      copyFileSync(FILE, file);
      const before = readFileSync(file, 'utf8');
      for (const report of [file, join(d, '.', 'export.json')]) {
        const r = cli(['--file', file, '--report', report]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/is the export --file itself/);
      }
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 180_000);
  it('a run killed mid-live (SIGKILL) leaves "running" in the --report it created', () => {
    const d = mkdtempSync(join(tmpdir(), 'sage-r17-'));
    try {
      const report = join(d, 'report.json');
      const r = cli(['--file', FILE, '--live', '--expect-items', '20', '--expect-pos', '10', '--report', report], { SAGE_DIE_AT_COMMIT: '2' }, 'tests/integration/helpers/sageDieAtCommitPreload.ts');
      expect(r.signal).toBe('SIGKILL');
      expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ status: 'running' });
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 180_000);
});
