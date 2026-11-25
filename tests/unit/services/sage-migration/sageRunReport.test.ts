/**
 * The --report file of run.ts (scripts/sage-migration/runReport.ts), under the round-16 rule (the path must NOT exist; the run creates it
 * exclusively) and the round-17 decision (it is written only through the descriptor of that create: no temp file, no rename).
 * Kept from earlier rounds: --report as any --file is refused (B15-1, a clear message), a value starting with `--` is never a path,
 * two different --report paths are refused, the stop report lists batches by outcome (B14-4), a summary failing after live is exit 4 (R14-L2).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReportArgs, exitAfterReportFailure, OwnedReport, sameFile, scanReportArgs, stopReportBody, summarize } from '../../../../scripts/sage-migration/runReport';
import { MigrationStopped } from '@/modules/accounting/services/sage-migration/sageMigrationStopped';
import type { BatchReport, MigrationReport } from '@/modules/accounting/services/sage-migration/sageMigrationTypes';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'sage-run-report-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const b = (entity: BatchReport['entity'], n: number, over: Partial<BatchReport> = {}): BatchReport =>
  ({ entity, n, size: 1, key: `k-${entity}-${n}`, status: 'ok', allRowsAlreadyPresent: false, rowsAbsent: 0, toolReported: {}, error: null, ...over });
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('round-16 rule: --report must not exist; the run creates it exclusively', () => {
  it('a new path is created holding "running"', () => {
    const p = join(dir(), 'report.json');
    expect(OwnedReport.create(p)).toBeInstanceOf(OwnedReport);
    expect(read(p)).toMatchObject({ status: 'running', pid: process.pid });
  });
  it('ANY existing file is refused and left byte for byte: an export, an earlier report, another tool\'s file that looks like a report (B16-2), a running run\'s placeholder (B16-1)', () => {
    const d = dir();
    for (const [name, body] of [['export.json', '{"Items":[]}'], ['old.json', '{"status":"completed"}'], ['.last-run.json', '{"status":"failed","failedTests":[]}'], ['run-a.json', '{"status":"running"}']]) {
      const p = join(d, name!);
      writeFileSync(p, body!);
      expect(OwnedReport.create(p)).toEqual({ why: expect.stringMatching(/already exists: .*pick a new path or delete the old file$/) });
      expect(readFileSync(p, 'utf8')).toBe(body);
    }
  });
  it('a symlink at the path (even dangling) is refused, its target untouched', () => {
    const d = dir();
    writeFileSync(join(d, 'export.json'), 'X');
    symlinkSync(join(d, 'export.json'), join(d, 'link.json'));
    symlinkSync(join(d, 'nowhere.json'), join(d, 'dangling.json'));
    for (const n of ['link.json', 'dangling.json']) expect('why' in (OwnedReport.create(join(d, n)) as object)).toBe(true);
    expect(readFileSync(join(d, 'export.json'), 'utf8')).toBe('X');
    expect(existsSync(join(d, 'nowhere.json'))).toBe(false);
  });
  it('a path that cannot be created (a missing directory) is refused: nothing written', () => {
    expect(OwnedReport.create(join(dir(), 'no-such-dir', 'r.json'))).toEqual({ why: expect.stringMatching(/cannot be written \(ENOENT/) });
  });
});

describe('round-17 decision: the report is written only through the descriptor of the create', () => {
  it('each write replaces the whole file in place; no temp file is ever made beside it', () => {
    const d = dir();
    const r = OwnedReport.create(join(d, 'report.json')) as OwnedReport;
    expect(r.write({ status: 'completed', rows: 'x'.repeat(5000) })).toBeNull();
    expect(r.write({ status: 'stopped' })).toBeNull(); // shorter: truncated, no tail of the longer one left
    expect(read(join(d, 'report.json'))).toEqual({ status: 'stopped' });
    expect(readdirSync(d)).toEqual(['report.json']);
    r.close();
  });
  it('B17-1: a file planted at any other name in the directory is never touched (there is no temp name to collide with)', () => {
    const d = dir();
    const r = OwnedReport.create(join(d, 'report.json')) as OwnedReport;
    for (let n = 0; n < 50; n++) writeFileSync(join(d, `.report.json.${process.pid}.${Date.now() + n}.tmp`), `planted ${n}`);
    expect(r.write({ status: 'completed' })).toBeNull();
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toHaveLength(50);
    for (const f of readdirSync(d).filter((x) => x.endsWith('.tmp'))) expect(readFileSync(join(d, f), 'utf8')).toMatch(/^planted \d+$/);
    r.close();
  });
  it('B17-2: a file moved onto the path during the run is never written; the run writes its own (moved) file', () => {
    const d = dir();
    const p = join(d, 'report.json');
    const r = OwnedReport.create(p) as OwnedReport;
    renameSync(p, join(d, 'moved-away.json'));
    writeFileSync(join(d, 'victim.json'), 'VICTIM');
    renameSync(join(d, 'victim.json'), p); // the victim now sits at the report path
    expect(r.write({ status: 'completed' })).toBeNull();
    expect(readFileSync(p, 'utf8')).toBe('VICTIM');
    expect(read(join(d, 'moved-away.json'))).toEqual({ status: 'completed' });
    r.close();
  });
  it('a hard link to an export put at the path after an unlink: the export is never written', () => {
    const d = dir();
    const p = join(d, 'report.json');
    writeFileSync(join(d, 'export.json'), 'EXPORT');
    const r = OwnedReport.create(p) as OwnedReport;
    unlinkSync(p);
    linkSync(join(d, 'export.json'), p);
    expect(r.write({ status: 'completed' })).toBeNull(); // written to the run's own unlinked inode
    expect(readFileSync(join(d, 'export.json'), 'utf8')).toBe('EXPORT');
    r.close();
  });
  it('write after close is refused, never thrown; close twice is harmless', () => {
    const r = OwnedReport.create(join(dir(), 'report.json')) as OwnedReport;
    r.close();
    r.close();
    expect(r.write({ status: 'x' })).toMatch(/could not be written: the file is closed/);
  });
});

describe('the arguments (kept from rounds 14-15)', () => {
  it('a value that starts with -- is never a path; up to a bare --', () => {
    expect(scanReportArgs(['--file', 'x.json', '--report', '--live'])).toEqual({ reports: [], files: ['x.json'] });
    expect(scanReportArgs(['--file=x.json', '--report=r.json', '--', '--report', 'y.json'])).toEqual({ reports: ['r.json'], files: ['x.json'] });
    expect(checkReportArgs(['--report=--live'], '--live')).toMatchObject({ ok: false, why: expect.stringMatching(/never taken as a path/) });
  });
  it('a path below a FILE (a trailing / after it): refused with why, never thrown', () => {
    const d = dir();
    writeFileSync(join(d, 'old.json'), 'OLD');
    const p = `${join(d, 'old.json')}/`;
    expect(checkReportArgs(['--report', p], p)).toEqual({ ok: false, why: expect.stringMatching(/cannot be written \(ENOTDIR.*\)$/) });
    expect(readFileSync(join(d, 'old.json'), 'utf8')).toBe('OLD');
  });
  it('R17-8: --report= (no path) has its own message', () => {
    expect(checkReportArgs(['--report='], '')).toEqual({ ok: false, why: '--report is given without a path (--report=): give a file path' });
  });
  it('two different --report paths are refused; the same one twice is one', () => {
    expect(checkReportArgs(['--report', 'a.json', '--report', 'b.json'], 'b.json')).toMatchObject({ ok: false, why: expect.stringMatching(/more than once/) });
    expect(checkReportArgs(['--report', 'a.json', '--report=a.json'], 'a.json')).toEqual({ ok: true, path: 'a.json' });
  });
  it('--report as any --file (path, symlink, hard link; every --file, not the last) is refused with its own message', () => {
    const d = dir();
    const file = join(d, 'export.json');
    writeFileSync(file, '{}');
    linkSync(file, join(d, 'hard.json'));
    expect(sameFile(join(d, 'hard.json'), file)).toBe(true);
    expect(sameFile(join(d, '.', 'export.json'), file)).toBe(true);
    expect(sameFile(join(d, 'other.json'), file)).toBe(false);
    expect(checkReportArgs(['--file', file, '--report', join(d, 'hard.json')], join(d, 'hard.json'))).toMatchObject({ ok: false, why: expect.stringMatching(/is the export --file itself/) });
    expect(checkReportArgs(['--file', file, '--report', file, '--file', join(d, 'b.json')], file)).toMatchObject({ ok: false, why: expect.stringMatching(/is the export --file itself/) });
  });
});

describe('the bodies and the exit codes', () => {
  it('B14-4: the stop report lists by outcome; a refused start lists nothing', () => {
    const err = new MigrationStopped(new Error('boom'), true, [b('item', 1), b('purchase_order', 1, { allRowsAlreadyPresent: true }),
      b('item', 2, { status: 'failed', commitUnconfirmed: true, toolRefused: true, toolReported: null, error: 'refused' })], { failed: [b('item', 3, { status: 'failed' })] });
    const body = stopReportBody(err) as Record<string, BatchReport[]>;
    const ids = (k: string) => body[k]!.map((x) => `${x.entity} ${x.n}`);
    expect([ids('committed'), ids('nothingWritten'), ids('commitUnconfirmed'), ids('failed')]).toEqual([['item 1'], ['purchase_order 1'], ['item 2'], ['item 3']]);
    expect(stopReportBody(new Error('--run-tag must be ...'))).toMatchObject({ status: 'stopped', liveStarted: false, committed: [], failed: [] });
  });
  it('R16-F6: a report that could not be written is exit 3 only where the run is otherwise 0', () => {
    expect([0, 1, 4].map(exitAfterReportFailure)).toEqual([3, 1, 4]);
  });
  it('R14-L2: a summary that fails after a live run is exit 4; after a dry run it is thrown', () => {
    const report = (live: boolean) => ({ live: live ? {} : null }) as unknown as MigrationReport;
    const boom = () => { throw new Error('summary bug'); };
    expect(summarize(report(true), false, false, { lines: boom, code: () => 0 })).toMatchObject({ code: 4, lines: [expect.stringMatching(/^the live run committed; the summary failed/)] });
    expect(() => summarize(report(false), false, false, { lines: boom, code: () => 0 })).toThrow('summary bug');
  });
});
