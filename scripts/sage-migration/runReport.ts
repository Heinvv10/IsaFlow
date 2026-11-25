/**
 * The --report file of scripts/sage-migration/run.ts. ONE rule (team-lead decision, round 16, after rounds 14-16 each found another way the
 * report overwrote a file it did not own): --report names a path that does NOT exist; the run creates it exclusively (open 'wx') once
 * every argument is checked and the export is read, before its first database step, and from then on writes ONLY through the descriptor
 * of that create (round 17: no temp file, no rename, no path lookup). So an export, an earlier run's report, another tool's file and a
 * running run's report are never touched: their path exists, so the run refuses to start (exit 2, nothing written anywhere).
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MigrationReport } from '../../src/modules/accounting/services/sage-migration/sageMigrationTypes';
import { MigrationStopped } from '../../src/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '../../src/modules/accounting/services/sage-migration/sageReportSummary';
import { stopMessage, stopReportBatches } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';

/**
 * Every --report and --file value in the arguments, up to a bare `--`. A value that starts with `--` is an option, never a path
 * (`--report --live` names no report).
 */
export function scanReportArgs(argv: readonly string[]): { reports: string[]; files: string[] } {
  const out = { reports: [] as string[], files: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--') break;
    for (const [flag, list] of [['--report', out.reports], ['--file', out.files]] as const) {
      if (t.startsWith(`${flag}=`)) { const v = t.slice(flag.length + 1); if (v !== '' && !v.startsWith('--')) list.push(v); }
      else if (t === flag) { const v = argv[i + 1]; if (v !== undefined && v !== '' && !v.startsWith('--')) { list.push(v); i++; } }
    }
  }
  return out;
}

/** The path as the file system sees it: realpath when it exists, else its directory's realpath and its name. */
function canonical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const dir = dirname(abs);
  return existsSync(dir) ? join(realpathSync(dir), basename(abs)) : abs;
}

/** One file: the same path (through a relative path or a symlink), or a hard link to it (the same device and inode). */
export function sameFile(a: string, b: string): boolean {
  if (canonical(a) === canonical(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const [x, y] = [statSync(a), statSync(b)];
  return x.dev === y.dev && x.ino === y.ino;
}

const alreadyExists = (path: string) => `--report ${path} already exists: the run writes only a new file, so pick a new path or delete the old file`;

/**
 * The --report the strictly parsed arguments name, checked against all the arguments: given once, never a value starting with `--`, and
 * none of the --file values (a clear message for the export itself), and a path that does not exist yet (the create checks it again).
 */
export function checkReportArgs(argv: readonly string[], parsed: string | undefined): { ok: true; path: string | undefined } | { ok: false; why: string } {
  const { reports, files } = scanReportArgs(argv);
  const distinct = [...new Set(reports)];
  if (distinct.length > 1) return { ok: false, why: `--report is given more than once (${distinct.join(', ')}): give one path` };
  if (parsed === undefined) return { ok: true, path: undefined };
  if (parsed === '') return { ok: false, why: '--report is given without a path (--report=): give a file path' };
  if (distinct[0] !== parsed) return { ok: false, why: `--report ${parsed}: a value that starts with -- is never taken as a path; give a file path` };
  const export_ = files.find((f) => sameFile(parsed, f));
  if (export_ !== undefined) return { ok: false, why: `--report ${parsed} is the export --file itself (${export_}): writing the report would overwrite it; give another path` };
  // Said early, before any other check, so a path that exists is named as the reason; the exclusive create stays the guard (a race).
  try {
    if (lstatSync(parsed, { throwIfNoEntry: false })) return { ok: false, why: alreadyExists(parsed) };
  } catch (err) { // ENOTDIR (a trailing / after a file), EACCES, ELOOP: the path cannot be a new file either
    return { ok: false, why: `--report ${parsed} cannot be written (${message(err)})` };
  }
  return { ok: true, path: parsed };
}

const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The report file this run created, written ONLY through the file descriptor of its exclusive create, held open for the whole run
 * (team-lead decision, round 17): ftruncate(0) + write at offset 0 + fsync. No temp file, no rename, no path lookup after the create: the
 * run can only ever write the inode it created. If the path is swapped meanwhile, the run writes its own moved or unlinked file, never
 * another one. A kill in the middle of a write can leave a partial file of the run's OWN inode (named limit).
 */
export class OwnedReport {
  private open = true;
  private constructor(readonly path: string, private readonly fd: number) {}

  /**
   * Create --report exclusively, holding the "running" placeholder. A path that exists, or a directory that cannot take it, is refused. If
   * the placeholder cannot be written (a full disk), the file it just created is removed again (only while the path is still that file).
   */
  static create(path: string): OwnedReport | { why: string; left?: true } {
    let fd: number;
    try { fd = openSync(path, 'wx', 0o644); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { why: code === 'EEXIST'
        ? alreadyExists(path)
        : `--report ${path} cannot be written (${message(err)})` };
    }
    const owned = new OwnedReport(path, fd);
    const why = owned.write({ status: 'running', startedAt: new Date().toISOString(), pid: process.pid });
    if (why === null) return owned;
    // R17-5: never leave an empty file behind. Unlinked only while the path is still the inode this run created; `left` says when it is
    // not removed (R18-4: the caller must not say "not created" then).
    let removed = false;
    try {
      const [mine, now] = [fstatSync(fd), lstatSync(path, { throwIfNoEntry: false })];
      if (now && now.dev === mine.dev && now.ino === mine.ino) { unlinkSync(path); removed = true; }
    } catch (err) { process.stderr.write(`--report ${path}: the file this run created could not be removed: ${message(err)}\n`); }
    owned.close();
    return removed ? { why } : { why, left: true };
  }

  /** Replace the whole report with `body` through the held descriptor. Returns why not, or null when written; never throws. */
  write(body: unknown): string | null {
    if (!this.open) return `--report ${this.path} could not be written: the file is closed`;
    try {
      const bytes = Buffer.from(json(body));
      ftruncateSync(this.fd, 0);
      let at = 0;
      while (at < bytes.length) at += writeSync(this.fd, bytes, at, bytes.length - at, at);
      fsyncSync(this.fd);
      return null;
    } catch (err) {
      return `--report ${this.path} could not be written: ${message(err)}`;
    }
  }

  /** Close the descriptor at the end of the run; an error closing it is reported, never thrown. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    try { closeSync(this.fd); } catch (err) { process.stderr.write(`--report ${this.path}: closing it failed: ${message(err)}\n`); }
  }
}

/** A stop report: what the stop knows, its batches listed by outcome. */
export function stopReportBody(err: unknown): Record<string, unknown> {
  const stopped = err instanceof MigrationStopped && err.liveStarted ? err : null;
  const batches = stopped ? stopReportBatches(stopped) : { committed: [], nothingWritten: [], commitUnconfirmed: [], failed: [] };
  return { status: 'stopped', liveStarted: stopped !== null, message: stopMessage(err), ...batches };
}

/** The exit code when the run's report could not be written: 3 only where the run would otherwise be 0 (a 1 or a 4 must not be hidden). */
export const exitAfterReportFailure = (code: number): number => (code === 0 ? 3 : code);

/**
 * The summary lines and the exit code of a finished run. If the summary itself fails AFTER a live run (its batches are committed), that
 * is not a refused start: "the live run committed; the summary failed: check the books", exit 4 (R14-L2). A dry run's failure is thrown.
 */
export function summarize(report: MigrationReport, allowRefusals: boolean, allowDifferences: boolean,
  fns: { lines: typeof summaryLines; code: typeof exitCodeFor } = { lines: summaryLines, code: exitCodeFor }): { lines: string[]; code: number } {
  try {
    return { lines: fns.lines(report), code: fns.code(report, allowRefusals, allowDifferences) };
  } catch (err) {
    if (report.live === null) throw err;
    return { lines: [`the live run committed; the summary failed (${err instanceof Error ? err.message : String(err)}): check the books (the report file holds what the run returned)`], code: 4 };
  }
}
