/**
 * Round-14 breaker B14-3 / B14-4 and review R14-L1 / R14-L2: the --report file of run.ts (scripts/sage-migration/runReport.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preReportArgs, sameFile, summarize, writeRunningReport, writeStopReport } from '../../../../scripts/sage-migration/runReport';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import type { BatchReport, MigrationReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'sage-run-report-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const b = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport =>
  ({ entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: {}, error: null, ...over });

describe('B14-3: --report is found before the strict parse', () => {
  it('a mistyped option does not hide it', () => {
    expect(preReportArgs(['--company', 'c', '--expect-po', '3', '--report', 'r.json', '--file', 'f.json'])).toEqual({ report: 'r.json', file: 'f.json' });
    expect(preReportArgs(['--report=r.json'])).toEqual({ report: 'r.json', file: undefined });
    expect(preReportArgs(['--live'])).toEqual({ report: undefined, file: undefined });
  });
  it('the running placeholder replaces an earlier report at once', () => {
    const p = join(dir(), 'report.json');
    writeFileSync(p, '{"status":"completed"}');
    expect(writeRunningReport(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({ status: 'running' });
  });
});

describe('R14-L1: --report naming the export', () => {
  it('the same file through a relative path or a symlink is the same file; another name is not', () => {
    const d = dir();
    const file = join(d, 'export.json');
    writeFileSync(file, '{}');
    symlinkSync(file, join(d, 'link.json'));
    expect(sameFile(file, join(d, '.', 'export.json'))).toBe(true);
    expect(sameFile(join(d, 'link.json'), file)).toBe(true);
    expect(sameFile(join(d, 'report.json'), file)).toBe(false);
  });
});

describe('B14-4: the stop report lists the batches by outcome', () => {
  it('committed holds only what wrote; nothing written, unconfirmed (a refusal among them) and failed are apart', () => {
    const p = join(dir(), 'report.json');
    const err = new MigrationStopped(new Error('boom'), true, [b('item', 1), b('purchase_order', 1, { allRowsAlreadyPresent: true }),
      b('item', 2, { status: 'failed', commitUnconfirmed: true, toolRefused: true, toolReported: null, error: 'refused' })], { failed: [b('item', 3, { status: 'failed' })], dryRun: [] });
    writeStopReport(p, err);
    const json = JSON.parse(readFileSync(p, 'utf8'));
    expect(json).toMatchObject({ status: 'stopped', liveStarted: true });
    const ids = (k: string) => (json[k] as BatchReport[]).map((x) => `${x.entity} ${x.n}`);
    expect([ids('committed'), ids('nothingWritten'), ids('commitUnconfirmed'), ids('failed')]).toEqual([['item 1'], ['purchase_order 1'], ['item 2'], ['item 3']]);
  });
  it('a refused start lists nothing', () => {
    const p = join(dir(), 'report.json');
    writeStopReport(p, new Error('--run-tag must be ...'));
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({ status: 'stopped', liveStarted: false, committed: [], failed: [] });
  });
});

describe('R14-L2: a summary that fails after a live run', () => {
  const report = (live: boolean) => ({ live: live ? { categories: {}, items: {}, purchaseOrders: {} } : null }) as unknown as MigrationReport;
  const boom = () => { throw new Error('summary bug'); };
  it('is exit 4 with "the live run committed; the summary failed: check the books", not a refused start', () => {
    const r = summarize(report(true), false, false, { lines: boom, code: () => 0 });
    expect(r.code).toBe(4);
    expect(r.lines[0]).toMatch(/^the live run committed; the summary failed \(summary bug\): check the books/);
    expect(summarize(report(true), false, false, { lines: () => ['ok'], code: boom }).code).toBe(4);
  });
  it('after a dry run (nothing written) it is thrown, as before', () => {
    expect(() => summarize(report(false), false, false, { lines: boom, code: () => 0 })).toThrow('summary bug');
    expect(summarize(report(false), false, false, { lines: () => ['a'], code: () => 1 })).toEqual({ lines: ['a'], code: 1 });
  });
});
