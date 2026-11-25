/**
 * The --report file of run.ts (scripts/sage-migration/runReport.ts), under the round-16 rule: the path must NOT exist; the run creates it
 * exclusively and from then on writes only the file it created (temp + rename, only while the path is still its inode).
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
      expect(OwnedReport.create(p)).toEqual({ why: expect.stringMatching(/already exists: .*pick a new path or delete the old file; nothing was written/) });
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
    expect(OwnedReport.create(join(dir(), 'no-such-dir', 'r.json'))).toEqual({ why: expect.stringMatching(/cannot be written .*nothing was written/) });
  });
});

describe('round-16 rule: the run writes only the file it created', () => {
  it('replaces it atomically (temp + rename): the content changes, no temp file is left', () => {
    const d = dir();
    const r = OwnedReport.create(join(d, 'report.json')) as OwnedReport;
    expect(r.write({ status: 'completed' })).toBeNull();
    expect(r.write({ status: 'completed', again: true })).toBeNull(); // the second write follows the inode the first put there
    expect(read(join(d, 'report.json'))).toEqual({ status: 'completed', again: true });
    expect(readdirSync(d)).toEqual(['report.json']);
  });
  it('a path replaced, hard-linked over or removed during the run is never written (the path swapped mid-run)', () => {
    const d = dir();
    const p = join(d, 'report.json');
    const exportFile = join(d, 'export.json');
    for (const change of [
      () => { unlinkSync(p); writeFileSync(p, 'someone else'); },
      () => { writeFileSync(exportFile, 'EXPORT'); unlinkSync(p); linkSync(exportFile, p); },
      () => { writeFileSync(exportFile, 'EXPORT'); unlinkSync(p); symlinkSync(exportFile, p); },
      () => { unlinkSync(p); },
    ]) {
      rmSync(p, { force: true });
      const r = OwnedReport.create(p) as OwnedReport;
      change();
      const before = existsSync(exportFile) ? readFileSync(exportFile, 'utf8') : null;
      expect(r.write({ status: 'stopped' })).toMatch(/is no longer the file this run created .*it is not written/);
      if (before !== null) expect(readFileSync(exportFile, 'utf8')).toBe(before);
      expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      rmSync(exportFile, { force: true });
    }
  });
  it('a rename by the run itself keeps the file its own (the inode is followed)', () => {
    const d = dir();
    const r = OwnedReport.create(join(d, 'report.json')) as OwnedReport;
    expect(r.write({ status: 'stopped' })).toBeNull();
    renameSync(join(d, 'report.json'), join(d, 'moved.json')); // someone moves it away: the path is no longer this run's
    expect(r.write({ status: 'completed' })).toMatch(/is no longer the file this run created/);
  });
});

describe('the arguments (kept from rounds 14-15)', () => {
  it('a value that starts with -- is never a path; up to a bare --', () => {
    expect(scanReportArgs(['--file', 'x.json', '--report', '--live'])).toEqual({ reports: [], files: ['x.json'] });
    expect(scanReportArgs(['--file=x.json', '--report=r.json', '--', '--report', 'y.json'])).toEqual({ reports: ['r.json'], files: ['x.json'] });
    expect(checkReportArgs(['--report=--live'], '--live')).toMatchObject({ ok: false, why: expect.stringMatching(/never taken as a path/) });
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
      b('item', 2, { status: 'failed', commitUnconfirmed: true, toolRefused: true, toolReported: null, error: 'refused' })], { failed: [b('item', 3, { status: 'failed' })], dryRun: [] });
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
