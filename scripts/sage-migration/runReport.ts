/**
 * The --report file of scripts/sage-migration/run.ts (round-14 B14-3, B14-4, R14-L1, R14-L2): it never holds an earlier run's report for
 * this one, never overwrites the export, and lists a stop's batches by what they did. What can be checked without a run is here.
 */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { MigrationReport } from '../../src/modules/accounting/services/sage-migration/sageMigrationTypes';
import { MigrationStopped } from '../../src/modules/accounting/services/sage-migration/sageMigrationStopped';
import { exitCodeFor, summaryLines } from '../../src/modules/accounting/services/sage-migration/sageReportSummary';
import { stopMessage, stopReportBatches } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';

/** --report and --file read BEFORE the strict parse, so a mistyped option (which makes the strict parse throw) still finds --report. */
export function preReportArgs(argv: readonly string[]): { report?: string; file?: string } {
  const { values } = parseArgs({ args: [...argv], options: { report: { type: 'string' }, file: { type: 'string' } }, strict: false, allowPositionals: true });
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  return { report: str(values.report), file: str(values.file) };
}

/** The path as the file system sees it: realpath when it exists, else its directory's realpath and its name. */
function canonical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const dir = dirname(abs);
  return existsSync(dir) ? join(realpathSync(dir), basename(abs)) : abs;
}

/** --report naming the export itself (also through a symlink or a relative path): writing the report would overwrite the export. */
export const sameFile = (a: string, b: string): boolean => canonical(a) === canonical(b);

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
export function writeStopReport(path: string, err: unknown): void {
  const stopped = err instanceof MigrationStopped && err.liveStarted ? err : null;
  const batches = stopped ? stopReportBatches(stopped) : { committed: [], nothingWritten: [], commitUnconfirmed: [], failed: [] };
  write(path, { status: 'stopped', liveStarted: stopped !== null, message: stopMessage(err), ...batches }, 'stop report');
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
