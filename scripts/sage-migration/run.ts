/**
 * Sage migration runner (Phase D). LOCAL DATABASES ONLY: it refuses to start unless DATABASE_URL (and any other database URL in
 * the environment) is a local throwaway database (src/modules/accounting/services/sage-migration/localGuard.ts).
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun --no-env-file scripts/sage-migration/run.ts \
 *     --company <uuid> --user <uuid> --file <export.json> [--live] [--report <file>] [--skip-budget-check] [--po-gl-account <uuid>] [--allow-refusals] [--allow-differences] [--run-tag <text>] \
 *     [--expect-items N] [--expect-pos N] [--expect-po-total 80950000.00]
 *
 * Without --live: the dry run only, nothing written. --live needs --expect-items and --expect-pos. --run-tag salts the batch keys, for a
 * deliberate fresh import after the rows of an earlier run were deleted (the registry would otherwise replay that run's answers). With --live: the dry run, then categories -> items -> purchase orders when
 * it is clean. --user must be an active member of --company (owner or admin to use --skip-budget-check). Exit 0 for a clean dry
 * run or a live run that booked every row it sent, whose --expect-* figures match what was sent (dry run) or booked (live) and
 * which refused no row (unless --allow-refusals) and found no PO or owned item differing from the books (unless --allow-differences); 1 for anything else; 2 for a refused start (nothing written), 4 when the run stopped on an error AFTER its live phase started, a live batch's COMMIT that did not answer among them (the run stops at that batch; batches may be committed: the message lists them; check the books, a re-run resumes), 3 when the run was otherwise ok but --report could not be written (the summary is printed first; a 1 stays).
 * `--no-env-file` keeps bun from loading a .env.local that names the dev database (the guard would refuse it anyway). Format and mapping: docs/design/sage-migration-export-format.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { UUID_RE } from '../../src/lib/validation';
import { RUN_TAG } from '../../src/modules/accounting/services/sage-migration/sageBatches';
import { assertLocalDatabase } from '../../src/modules/accounting/services/sage-migration/localGuard';
import { parseSageExport } from '../../src/modules/accounting/services/sage-migration/sageExportParser';
import { runSageMigration } from '../../src/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeForError, stopMessage } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';
import { RunInProgressError } from '../../src/modules/accounting/services/sage-migration/sageRunLock';
import { checkReportTarget, summarize, writeRunningReport, writeStopReport } from './runReport';

const out = (s: string) => process.stdout.write(`${s}\n`);
/**
 * --report once it is known to be safe to write (checkReportTarget). Every exit after that leaves a report there: the stop report of a
 * refusal or a stop, the run's own report at the end; except a refusal by the run lock (the report belongs to the run that holds it) and a
 * --report that could not be written (nothing more to try).
 */
let reportPath: string | undefined;
/** The run's own report (or a stop report) is written: nothing more goes to --report. */
let reportDone = false;
class ReportUnwritableError extends Error {}
const leaveStopReport = (err: unknown): void => {
  if (!reportPath || reportDone || err instanceof RunInProgressError || err instanceof ReportUnwritableError) return;
  reportDone = true;
  writeStopReport(reportPath, err);
};
const fail = (s: string): never => {
  process.stderr.write(`${s}\n`);
  leaveStopReport(new Error(s));
  process.exit(2);
};

/** "80950000.00" -> 8095000000 cents, exactly (no float). */
function cents(text: string): number {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return fail(`not an amount: ${text}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
const parseCli = () => parseArgs({
  options: {
    company: { type: 'string' }, user: { type: 'string' }, file: { type: 'string' }, report: { type: 'string' },
    live: { type: 'boolean', default: false }, 'skip-budget-check': { type: 'boolean', default: false }, 'po-gl-account': { type: 'string' }, 'allow-refusals': { type: 'boolean', default: false }, 'run-tag': { type: 'string' }, 'allow-differences': { type: 'boolean', default: false },
    'expect-items': { type: 'string' }, 'expect-pos': { type: 'string' }, 'expect-po-total': { type: 'string' },
  },
  strict: true,
});

const count = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) return fail(`not a count: ${text}`);
  return Number(text);
};

async function main(): Promise<void> {
  // --report is checked before anything else, and before anything is written there (round 15, B15-1).
  const target = checkReportTarget(process.argv.slice(2));
  if (!target.ok) {
    process.stderr.write(`${target.why}\n`);
    process.exit(2);
  }
  reportPath = target.path;
  let parsedArgs: ReturnType<typeof parseCli>;
  try { parsedArgs = parseCli(); } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
  const { values } = parsedArgs;
  try { assertLocalDatabase(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  if (!values.company || !UUID_RE.test(values.company)) fail('--company <uuid> is required');
  if (!values.user || !UUID_RE.test(values.user)) fail('--user <uuid> is required');
  if (!values.file) fail('--file <export.json> is required');
  if (values['run-tag'] !== undefined && !RUN_TAG.test(values['run-tag'])) fail('--run-tag must be 1-32 letters, digits, - or _');
  if (values.live && (values['expect-items'] === undefined || values['expect-pos'] === undefined)) {
    fail('--live needs --expect-items and --expect-pos (the counts you expect to be booked, 0 if none), so an export that lost a container cannot pass unnoticed');
  }
  if (values['po-gl-account'] !== undefined && !UUID_RE.test(values['po-gl-account'])) fail('--po-gl-account must be an expense account uuid');

  const parsed = parseSageExport(JSON.parse(readFileSync(values.file!, 'utf8')));
  const expect = {
    items: count(values['expect-items']), purchaseOrders: count(values['expect-pos']),
    purchaseOrderTotalCents: values['expect-po-total'] === undefined ? undefined : cents(values['expect-po-total']),
  };
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  pool.on('error', (err) => process.stderr.write(`database pool error: ${err.message}\n`));
  try {
    const report = await runSageMigration(pool, parsed, {
      companyId: values.company!.toLowerCase(), userId: values.user!.toLowerCase(), live: values.live, skipBudgetCheck: values['skip-budget-check'], poGlAccountId: values['po-gl-account']?.toLowerCase(), runTag: values['run-tag'], allowRefusals: values['allow-refusals'] === true, allowDifferences: values['allow-differences'] === true,
      expect,
      // Once the run lock is held (B15-2), an earlier run's report is replaced at once (a run killed mid-way leaves "running"); a --report
      // that cannot be written ends the run there, exit 2, nothing written (B15-3).
      onLocked: () => {
        if (reportPath && !writeRunningReport(reportPath)) throw new ReportUnwritableError(`--report ${reportPath} cannot be written: nothing was written`);
      },
    });
    // The summary is printed FIRST: a committed run must always tell what it did, whatever happens to the report file.
    const { lines, code } = summarize(report, values['allow-refusals'] === true, values['allow-differences'] === true);
    for (const line of lines) (code === 4 ? process.stderr.write(`${line}\n`) : out(line));
    process.exitCode = code;
    if (reportPath) {
      reportDone = true;
      try {
        writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      } catch (err) {
        // Exit 3 only when the run would otherwise be 0: a 1 (not ok) must not be hidden by a report that
        // could not be written. The summary above says what the run did; this says what happened to the report.
        const why = err instanceof Error ? err.message : String(err);
        process.stderr.write(code === 0
          ? `the run finished (exit 0 without this) but the report could not be written to ${values.report}: ${why}\n`
          : `the report could not be written to ${values.report}: ${why} (the exit code stays ${code}: see the summary above)\n`);
        if (code === 0) process.exitCode = 3;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${stopMessage(err)}\n`);
  leaveStopReport(err); // every other exit path (a stop, a refusal, a summary that failed after a dry run) leaves a stop report
  process.exit(exitCodeForError(err));
});
