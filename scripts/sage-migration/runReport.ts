/**
 * The --report file of scripts/sage-migration/run.ts (round-14 B14-3, B14-4, R14-L1, R14-L2): it never holds an earlier run's report for
 * this one, never overwrites the export, and lists a stop's batches by what they did. What can be checked without a run is here.
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MigrationReport } from '../../src/modules/accounting/services/sage-migration/sageMigrationTypes';
import { MigrationStopped } from '../../src/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '../../src/modules/accounting/services/sage-migration/sageReportSummary';
import { stopMessage, stopReportBatches } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';

/**
 * Every --report and --file value in the arguments, read BEFORE the strict parse (a mistyped option makes it throw), up to a bare `--`.
 * A value that starts with `--` is an option, never a path (`--report --live` names no report).
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

/** The statuses of the tool's own report files: a run report, a stop report, or the running placeholder. */
export const REPORT_STATUSES = ['running', 'stopped', 'dry_run_ok', 'dry_run_failed', 'live_blocked', 'completed', 'failed'];

/** An existing file that is one of the tool's own reports (a JSON object whose status is one of REPORT_STATUSES). */
export function isToolReport(path: string): boolean {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) && REPORT_STATUSES.includes(String((v as { status?: unknown }).status));
  } catch { return false; }
}

/**
 * Whether --report may be written at all (round-15 B15-1, R15-L1): it is not any --file given (by path, symlink or hard link), it is given
 * once, and a file already there is one of the tool's own reports (anything else, the export swapped in by mistake among them, is never
 * overwritten). Refused: exit 2, nothing written anywhere.
 */
export function checkReportTarget(argv: readonly string[]): { ok: true; path: string | undefined } | { ok: false; why: string } {
  const { reports, files } = scanReportArgs(argv);
  const distinct = [...new Set(reports)];
  if (distinct.length > 1) return { ok: false, why: `--report is given more than once (${distinct.join(', ')}): give one path` };
  const path = distinct[0];
  if (path === undefined) return { ok: true, path: undefined };
  const export_ = files.find((f) => sameFile(path, f));
  if (export_ !== undefined) return { ok: false, why: `--report ${path} is the export --file itself (${export_}): writing the report would overwrite it; give another path` };
  if (existsSync(path) && !isToolReport(path)) {
    return { ok: false, why: `--report ${path} exists and is not a report of this tool (a JSON object with a status of ${REPORT_STATUSES.join(' / ')}): it is not overwritten; give another path` };
  }
  return { ok: true, path };
}

function write(path: string, body: unknown, what: string): boolean {
  try {
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    return true;
  } catch (err) {
    process.stderr.write(`the ${what} could not be written to ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

/** At the start of a run: an earlier run's report is replaced at once, so a run killed mid-way leaves "running", never the old report. */
export const writeRunningReport = (path: string): boolean => write(path, { status: 'running', startedAt: new Date().toISOString() }, 'running placeholder');

/** A run that stopped (or was refused): what the stop knows, its batches listed by outcome. Best effort: the exit code is the stop's. */
export function writeStopReport(path: string, err: unknown): boolean {
  const stopped = err instanceof MigrationStopped && err.liveStarted ? err : null;
  const batches = stopped ? stopReportBatches(stopped) : { committed: [], nothingWritten: [], commitUnconfirmed: [], failed: [] };
  return write(path, { status: 'stopped', liveStarted: stopped !== null, message: stopMessage(err), ...batches }, 'stop report');
}

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
