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
 * --report must name a path that does not exist: the run creates it and writes only that file (scripts/sage-migration/runReport.ts).
 * `--no-env-file` keeps bun from loading a .env.local that names the dev database (the guard would refuse it anyway). Format and mapping: docs/design/sage-migration-export-format.md.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { UUID_RE } from '../../src/lib/validation';
import { RUN_TAG } from '../../src/modules/accounting/services/sage-migration/sageBatches';
import { assertLocalDatabase } from '../../src/modules/accounting/services/sage-migration/localGuard';
import { parseSageExport } from '../../src/modules/accounting/services/sage-migration/sageExportParser';
import { runSageMigration } from '../../src/modules/accounting/services/sage-migration/sageMigrationRunner';
import { exitCodeForError, stopMessage } from '../../src/modules/accounting/services/sage-migration/sageStopMessage';
import { checkReportArgs, exitAfterReportFailure, OwnedReport, stopReportBody, summarize } from './runReport';

const out = (s: string) => process.stdout.write(`${s}\n`);
/**
 * The --report file this run created (runReport.ts: a path that did not exist, created exclusively right after the arguments are
 * parsed). Every exit after that leaves a report in it: the stop report of a refusal or a stop, the run's own report at the end. A refusal
 * before it exists writes no report anywhere (stderr only).
 */
let owned: OwnedReport | null = null;
/** The run's own report (or a stop report) is written: nothing more goes to --report. */
let reportDone = false;
const leaveStopReport = (err: unknown): void => {
  if (!owned || reportDone) return;
  reportDone = true;
  const why = owned.write(stopReportBody(err));
  if (why) process.stderr.write(`${why}\n`);
};
/** A refused start: exit 2, its stop report in --report once the run created it (before that, stderr only: there is no file of its own). */
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
  let parsedArgs: ReturnType<typeof parseCli>;
  try { parsedArgs = parseCli(); } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
  const { values } = parsedArgs;
  // --report is created exclusively as the run's FIRST write (round 16): a path that exists is never written, and nothing else is.
  const target = checkReportArgs(process.argv.slice(2), values.report);
  if (!target.ok) return fail(target.why);
  if (target.path !== undefined) {
    const created = OwnedReport.create(target.path);
    if (!(created instanceof OwnedReport)) return fail(created.why);
    owned = created;
  }
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
    });
    // The summary is printed FIRST: a committed run must always tell what it did, whatever happens to the report file.
    const { lines, code } = summarize(report, values['allow-refusals'] === true, values['allow-differences'] === true);
    for (const line of lines) (code === 4 ? process.stderr.write(`${line}\n`) : out(line));
    process.exitCode = code;
    if (owned) {
      reportDone = true;
      const why = owned.write(report);
      if (why) {
        // The summary above says what the run did; this says what happened to the report. A 1 or a 4 is never hidden by it.
        const next = exitAfterReportFailure(code);
        process.stderr.write(next === 3 ? `the run finished (exit 0 without this) but the report was not written: ${why}\n` : `the report was not written: ${why} (the exit code stays ${code}: see the summary above)\n`);
        process.exitCode = next;
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
