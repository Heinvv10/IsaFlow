/**
 * Sage migration runner (Phase D). LOCAL DATABASES ONLY: it refuses to start unless DATABASE_URL (and any other database URL in
 * the environment) is a local throwaway database (src/modules/accounting/services/sage-migration/localGuard.ts).
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun scripts/sage-migration/run.ts \
 *     --company <uuid> --user <uuid> --file <export.json> [--live] [--report <file>] [--skip-budget-check] \
 *     [--expect-items N] [--expect-pos N] [--expect-po-total 80950000.00]
 *
 * Without --live: the dry run only, nothing written. With --live: the dry run, then categories -> items -> purchase orders when
 * it is clean. --user must be an active member of --company (owner or admin to use --skip-budget-check). Exit 0 for a clean dry
 * run or a complete live run, 1 for anything else, 2 for a refused start. Format and mapping: docs/design/sage-migration-export-format.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { UUID_RE } from '../../src/lib/validation';
import { assertLocalDatabase } from '../../src/modules/accounting/services/sage-migration/localGuard';
import { parseSageExport } from '../../src/modules/accounting/services/sage-migration/sageExportParser';
import { runSageMigration } from '../../src/modules/accounting/services/sage-migration/sageMigrationRunner';
import { summaryLines } from '../../src/modules/accounting/services/sage-migration/sageReportSummary';

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string): never => { process.stderr.write(`${s}\n`); process.exit(2); };

/** "80950000.00" -> 8095000000 cents, exactly (no float). */
function cents(text: string): number {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return fail(`not an amount: ${text}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
const count = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) return fail(`not a count: ${text}`);
  return Number(text);
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      company: { type: 'string' }, user: { type: 'string' }, file: { type: 'string' }, report: { type: 'string' },
      live: { type: 'boolean', default: false }, 'skip-budget-check': { type: 'boolean', default: false },
      'expect-items': { type: 'string' }, 'expect-pos': { type: 'string' }, 'expect-po-total': { type: 'string' },
    },
    strict: true,
  });
  try { assertLocalDatabase(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  if (!values.company || !UUID_RE.test(values.company)) fail('--company <uuid> is required');
  if (!values.user || !UUID_RE.test(values.user)) fail('--user <uuid> is required');
  if (!values.file) fail('--file <export.json> is required');

  const parsed = parseSageExport(JSON.parse(readFileSync(values.file!, 'utf8')));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const report = await runSageMigration(pool, parsed, {
      companyId: values.company!.toLowerCase(), userId: values.user!.toLowerCase(), live: values.live, skipBudgetCheck: values['skip-budget-check'],
      expect: {
        items: count(values['expect-items']), purchaseOrders: count(values['expect-pos']),
        purchaseOrderTotalCents: values['expect-po-total'] === undefined ? undefined : cents(values['expect-po-total']),
      },
    });
    if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
    for (const line of summaryLines(report)) out(line);
    process.exitCode = report.status === 'dry_run_ok' || report.status === 'completed' ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`sage migration stopped: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
