/**
 * runReseed: the whole reseed as ONE transaction (PLAN 2.3). Guards, census,
 * counts, wipe, setup, seed, depreciation history, counters, balance cache,
 * post-checks; COMMIT only when every post-check passes, else ROLLBACK.
 * `--dry-run` and `--check-only` run in a READ ONLY transaction and write nothing.
 *
 * An injected `client` (the integration test) runs the same steps inside a
 * SAVEPOINT on the caller's transaction instead of BEGIN/COMMIT.
 */

import pg from 'pg';
import { SA_STANDARD_VAT_RATE_PCT } from '../../../src/lib/vat/standardRate';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import { Refusal, assertDemoCompany, assertTodayNotFuture, assertTransportSafe, type Mode } from './cli';
import { windowFor } from './dates';
import { txOver, type Tx } from './db';
import { postDepreciationHistory } from './depreciation';
import { withAppContext } from './appContext';
import { withApprovalGateExempt } from '../../../src/modules/accounting/services/gl/approvalGateExempt';
import { generateDemoData } from './generate';
import { describeSession, refuseUnsafe } from './guards';
import { renderReport, renderCounts } from './report';
import { deployChecks, runPostChecks, type ExtraCheck } from './postCheck';
import { SEED_TABLES } from './types';
import { countWipe, keptReport, runWipe } from './wipe';
import { finaliseRuns, reopenFinalRuns, splitFinalHeaders } from './payrollFinal';
import {
  basicSalaryComponent, ensureFiscalCalendar, genericBankMetadata, insertRows, leaveTypes, readDocFamilies, rebuildBalances,
  renameCompany, resolveAccounts, resolveActor, setDocCounters,
} from './write';

export interface RunOptions {
  companyId: string;
  mode: Mode;
  seed: number;
  today?: string;
  url?: string;
  /** Run inside the caller's open transaction (SAVEPOINT) instead of opening one. */
  client?: pg.Client;
  out: (line: string) => void;
  extraChecks?: ExtraCheck[];
  gitSha?: string;
}

export interface RunResult { exitCode: 0 | 1 | 2; inserted: Record<string, number>; deleted: Record<string, number> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runReseed(opts: RunOptions): Promise<RunResult> {
  let companyId: string;
  try {
    companyId = assertDemoCompany(opts.companyId);
  } catch (err) {
    if (err instanceof Refusal) return refused(opts, err);
    throw err;
  }
  const own = !opts.client;
  if (own) {
    try {
      assertTransportSafe(opts.url ?? '');
    } catch (err) {
      if (err instanceof Refusal) return refused(opts, err);
      throw err;
    }
  }
  // No ssl override: the URL's sslmode decides, and pg verifies the certificate when TLS is asked for.
  const client = opts.client ?? new pg.Client({ connectionString: opts.url });
  if (own) await client.connect();
  const readOnly = opts.mode !== 'run';
  const tx = txOver(client);
  await tx.query(own ? (readOnly ? 'BEGIN READ ONLY' : 'BEGIN') : 'SAVEPOINT demo_reseed');
  let committed = false;
  try {
    const result = await steps(tx, companyId, opts, readOnly);
    if (result.exitCode === 0 && !readOnly) {
      await tx.query(own ? 'COMMIT' : 'RELEASE SAVEPOINT demo_reseed');
      committed = true;
    }
    return result;
  } catch (err) {
    if (err instanceof Refusal) return refused(opts, err);
    throw err;
  } finally {
    if (!committed) {
      if (own) await rollbackFailed(client, 'reseed-demo-company');
      else await tx.query('ROLLBACK TO SAVEPOINT demo_reseed');
    }
    if (own) await client.end();
  }
}

function refused(opts: RunOptions, err: Refusal): RunResult {
  opts.out(`REFUSED: ${err.message}`);
  return { exitCode: 2, inserted: {}, deleted: {} };
}

async function steps(tx: Tx, companyId: string, opts: RunOptions, readOnly: boolean): Promise<RunResult> {
  const out = opts.out;
  await tx.query("SELECT set_config('lock_timeout', '10s', true), set_config('statement_timeout', '10min', true)");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-reseed', 0))");
  const { dbToday } = await describeSession(tx, companyId, out);
  const today = opts.today ?? dbToday;
  assertTodayNotFuture(today, dbToday);
  const win = windowFor(today);
  out(`window: ${win.windowStart} to ${today} (24 months, nothing after ${today}); seed ${opts.seed}`);

  if (opts.mode === 'check-only') {
    const report = await runPostChecks(tx, { companyId, win, extraChecks: opts.extraChecks });
    renderReport(report, out);
    return { exitCode: report.failed ? 1 : 0, inserted: {}, deleted: {} };
  }
  await refuseUnsafe(tx, companyId, out);
  const before = await deployChecks(tx);
  const wouldDelete = await countWipe(tx, companyId);
  renderCounts('would delete', wouldDelete, out);

  const actorId = await resolveActor(tx, companyId);
  const actor = UUID.test(actorId) ? actorId : '';
  if (!actor) throw new Refusal(`the company's owner user id "${actorId}" is not a uuid`);
  const accounts = await resolveAccounts(tx, companyId);
  const data = generateDemoData({
    today, seed: opts.seed, companyId, actorId: actor, accounts, vatRatePct: SA_STANDARD_VAT_RATE_PCT,
    docs: await readDocFamilies(tx, companyId),
    payroll: { basicComponent: await basicSalaryComponent(tx, companyId, !readOnly), leaveTypes: await leaveTypes(tx, companyId) },
  });
  const inserted = Object.fromEntries(SEED_TABLES.map((t) => [t, data.rows[t].length]));
  renderCounts(readOnly ? 'would insert' : 'insert', SEED_TABLES.map((t) => ({ table: t, n: data.rows[t].length })), out);
  if (readOnly) {
    renderCounts('kept', await keptReport(tx, companyId), out);
    out('dry run: nothing written (READ ONLY transaction rolled back)');
    return { exitCode: 0, inserted, deleted: Object.fromEntries(wouldDelete.map((c) => [c.table, c.n])) };
  }

  await reopenFinalRuns(tx, companyId);
  const deleted = Object.fromEntries((await runWipe(tx, companyId)).map((c) => [c.table, c.n]));
  const left = (await countWipe(tx, companyId)).filter((c) => c.n > 0);
  if (left.length > 0) throw new Error(`wipe left Demo rows in: ${left.map((c) => `${c.table} (${c.n})`).join(', ')}`);
  await renameCompany(tx, companyId);
  await genericBankMetadata(tx, companyId, accounts.bank, win);
  await ensureFiscalCalendar(tx, companyId, win);
  const runs = splitFinalHeaders(data.rows.payroll_run_headers);
  for (const t of SEED_TABLES) {
    // Invoices and bills are history the books already hold: they go in through the app's import exemption
    // (withApprovalGateExempt, with its rank check), as every importer's do, never by setting the gate off by hand.
    const documentType = t === 'customer_invoices' ? 'customer_invoice' : t === 'supplier_invoices' ? 'supplier_invoice' : null;
    if (documentType) {
      await withAppContext(tx.client, { userId: actor, companyId }, () =>
        withApprovalGateExempt({ companyId, userId: actor, open: true, documentType }, () => insertRows(tx, t, data.rows[t])));
    } else {
      await insertRows(tx, t, t === 'payroll_run_headers' ? runs.insert : data.rows[t]);
    }
  }
  await finaliseRuns(tx, companyId, runs.finals);
  const firstPurchase = data.rows.assets.map((a) => String(a.purchase_date)).sort()[0];
  if (firstPurchase) {
    const dep = await postDepreciationHistory(tx.client, companyId, actor, firstPurchase, win);
    out(`depreciation history: ${dep.months} month(s), ${dep.journals} journal(s) by the app's depreciation service; closed months skipped: ${dep.skippedClosed.join(', ') || 'none'}`);
  }
  await setDocCounters(tx, companyId, data.nextNumbers);
  await rebuildBalances(tx, companyId);
  const [{ txid }] = (await tx.query<{ txid: string }>('SELECT txid_current()::text AS txid')) as [{ txid: string }];
  out(`run record: txid=${txid} git=${opts.gitSha ?? 'unknown'} today=${today} seed=${opts.seed} opening_capital=${data.openingCapitalCents / 100}`);

  const report = await runPostChecks(tx, { companyId, win, before, extraChecks: opts.extraChecks });
  renderReport(report, out);
  if (report.failed) {
    out('POST-CHECK FAILED: rolling back, nothing changed');
    return { exitCode: 1, inserted, deleted };
  }
  out('all post-checks passed: committing');
  return { exitCode: 0, inserted, deleted };
}
