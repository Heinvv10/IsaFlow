/**
 * The --report file of scripts/sage-migration/run.ts. ONE rule (team-lead decision, round 16, after rounds 14-16 each found another way the
 * report overwrote a file it did not own): --report names a path that does NOT exist; the run creates it exclusively (open 'wx') as its
 * first write, right after the arguments are parsed, and from then on writes ONLY to the file it created: each write goes to a temp file in
 * the same directory and is renamed over the path only while the path is still the inode this run last put there (a path changed under
 * the run, replaced, linked or deleted, is never written: stderr, exit 3). So an export, an earlier run's report, another tool's file and
 * a running run's report are never touched: their path exists, so the run refuses to start (exit 2, nothing written anywhere).
 */
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
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

/**
 * The --report the strictly parsed arguments name, checked against all the arguments: given once, never a value starting with `--`, and
 * none of the --file values (a clear message for the export itself; its path exists anyway, so the create would refuse it too).
 */
export function checkReportArgs(argv: readonly string[], parsed: string | undefined): { ok: true; path: string | undefined } | { ok: false; why: string } {
  const { reports, files } = scanReportArgs(argv);
  const distinct = [...new Set(reports)];
  if (distinct.length > 1) return { ok: false, why: `--report is given more than once (${distinct.join(', ')}): give one path` };
  if (parsed === undefined) return { ok: true, path: undefined };
  if (distinct[0] !== parsed) return { ok: false, why: `--report ${parsed}: a value that starts with -- is never taken as a path; give a file path` };
  const export_ = files.find((f) => sameFile(parsed, f));
  if (export_ !== undefined) return { ok: false, why: `--report ${parsed} is the export --file itself (${export_}): writing the report would overwrite it; give another path` };
  return { ok: true, path: parsed };
}

const json = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The report file this run created: the inode it last put at that path AND the bytes it wrote there (a freed inode number is reused by
 * the file system, so a file put there by someone else can carry the same one; it does not carry the same bytes). The only file it writes.
 */
export class OwnedReport {
  private constructor(readonly path: string, private dev: number, private ino: number, private bytes: string) {}

  /** Create --report exclusively, holding the "running" placeholder. A path that exists, or a directory that cannot take it, is refused. */
  static create(path: string): OwnedReport | { why: string } {
    let fd: number;
    try { fd = openSync(path, 'wx', 0o644); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { why: code === 'EEXIST'
        ? `--report ${path} already exists: the run writes only a new file, so pick a new path or delete the old file; nothing was written`
        : `--report ${path} cannot be written (${message(err)}): nothing was written` };
    }
    try {
      const bytes = json({ status: 'running', startedAt: new Date().toISOString(), pid: process.pid });
      writeSync(fd, bytes);
      const s = fstatSync(fd);
      return new OwnedReport(path, s.dev, s.ino, bytes);
    } finally { closeSync(fd); }
  }

  /** Replace the report with `body`, atomically, only while the path is still this run's file. Returns why not, or null when written. */
  write(body: unknown): string | null {
    const tmp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | undefined;
    try {
      const bytes = json(body);
      fd = openSync(tmp, 'wx', 0o644);
      writeSync(fd, bytes);
      const s = fstatSync(fd);
      closeSync(fd);
      fd = undefined;
      const now = lstatSync(this.path, { throwIfNoEntry: false });
      if (!now || !now.isFile() || now.dev !== this.dev || now.ino !== this.ino || readFileSync(this.path, 'utf8') !== this.bytes) {
        unlinkSync(tmp);
        return `--report ${this.path} is no longer the file this run created (it was replaced, linked or removed during the run): it is not written`;
      }
      renameSync(tmp, this.path);
      [this.dev, this.ino, this.bytes] = [s.dev, s.ino, bytes];
      return null;
    } catch (err) {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
      return `--report ${this.path} could not be written: ${message(err)}`;
    }
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
