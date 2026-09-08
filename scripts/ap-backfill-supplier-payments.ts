/**
 * Mint the supplier payment documents that bank allocation never created.
 *
 * Cash allocated to a supplier before #340 (2026-09-08) posted DR Accounts
 * Payable / CR Bank and created no `supplier_payments` row, so the control
 * account moved and the subledger did not. Every AP tool reads payment rows and
 * there was no row to read. Migration 615 installs the classification and the
 * writer; this is the operator's hand on them.
 *
 *   bun scripts/ap-backfill-supplier-payments.ts --company <uuid>
 *   bun scripts/ap-backfill-supplier-payments.ts --company <uuid> --commit
 *   bun scripts/ap-backfill-supplier-payments.ts --rollback <batch-uuid> --commit
 *
 * WITHOUT `--commit` IT ROLLS BACK. The default run does the whole thing inside
 * one transaction, measures the books on both sides of it, prints the diff and
 * throws it away. That is the only honest dry run available here: the figures
 * that matter — unapplied cash, the aged report, the reconciliation — are
 * produced by services reading the ledger, not by predicting what they would
 * say.
 *
 * THE CONNECTION MUST BYPASS RLS. `supplier_payments` carries a forced
 * tenant_isolation policy whose WITH CHECK reads `app.current_company_id()`,
 * which is set by the request middleware and by nothing here. Run this as a
 * role with BYPASSRLS — `postgres` and `migration_admin` both have it, and
 * DATABASE_URL is `postgres` in every environment. On a role without it every
 * INSERT is refused outright, which is loud rather than silent, but it is
 * refused after the diff has been printed and is a wasted run.
 *
 * WHAT MUST NOT MOVE, and is asserted rather than asserted-to:
 *   · the AP control balance. No journal is posted; a change means one was.
 *   · every bank account's gl / statement / computed balance and its residual.
 *   · `supplier_invoices.amount_paid`. Applying the cash is a separate,
 *     judgement-bearing step.
 * A non-zero delta on any of these fails the run and refuses to commit.
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';
import { getBankStatementCoverage } from '@/modules/accounting/services/bank/bankStatementCoverageService';
import { fmtDate } from '@/lib/fmtDate';

const args = process.argv.slice(2);
/**
 * A flag's value, refusing to read the NEXT FLAG as one. `--company --commit`
 * otherwise takes "--commit" as the company uuid while `includes('--commit')`
 * still sees the mode — so the run reports a company it never used, in a mode
 * the operator did not read off the command line.
 */
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value (got ${value ?? 'nothing'}).`);
  }
  return value;
};
const COMPANY_ID = flag('company') ?? null;
const ROLLBACK_BATCH = flag('rollback') ?? null;
const COMMIT = args.includes('--commit');
const AS_AT = flag('as-at') ?? fmtDate(new Date());

const money = (n: number): string =>
  `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Everything this run is not allowed to move. */
interface Invariants {
  controlBalance: number;
  subledgerTotal: number;
  difference: number;
  amountPaidTotal: number;
  bank: { gl: number; statement: number; computed: number; difference: number; residual: number };
  bankAccounts: number;
}

/** What it IS allowed to move. */
interface Visible {
  unappliedTotal: number;
  unappliedRows: number;
  paymentRows: number;
}

async function readInvariants(companyId: string): Promise<Invariants> {
  const recon = await reconcileSubledger(companyId, 'ap', AS_AT);
  const paid = (await sql`
    SELECT COALESCE(SUM(amount_paid), 0) AS total
    FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND deleted_at IS NULL
  `) as DbRow[];
  const coverage = await getBankStatementCoverage(companyId, { asAt: AS_AT });
  return {
    controlBalance: recon.controlAccountBalance,
    subledgerTotal: recon.subledgerTotal ?? 0,
    difference: recon.difference ?? 0,
    amountPaidTotal: Number(paid[0]?.total ?? 0),
    bank: {
      gl: coverage.totals.glBalance,
      statement: coverage.totals.statementBalance,
      computed: coverage.totals.computedBalance,
      difference: coverage.totals.difference,
      residual: coverage.totals.unexplainedResidual,
    },
    bankAccounts: coverage.accounts.length,
  };
}

async function readVisible(companyId: string): Promise<Visible> {
  const unapplied = await getUnappliedPayments(companyId, { asAt: AS_AT, limit: 1 });
  const rows = (await sql`
    SELECT COUNT(*) AS n FROM supplier_payments WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  return {
    unappliedTotal: unapplied.totalUnapplied + unapplied.totalUnattributed,
    unappliedRows: unapplied.rowsTotal + unapplied.unattributed.length,
    paymentRows: Number(rows[0]?.n ?? 0),
  };
}

function diffLine(label: string, before: number, after: number, mustHold: boolean): boolean {
  const delta = Math.round((after - before) * 100) / 100;
  const ok = !mustHold || delta === 0;
  const mark = mustHold ? (ok ? 'HELD  ' : 'BROKEN') : 'MOVED ';
  console.log(
    `  ${mark} ${label.padEnd(34)} ${money(before).padStart(18)} -> ${money(after).padStart(18)}`
    + `  ${delta === 0 ? '' : `Δ ${money(delta)}`}`,
  );
  return ok;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  if (!COMPANY_ID && !ROLLBACK_BATCH) {
    throw new Error('--company <uuid> is required (this is a per-tenant remedy)');
  }

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let healthy = true;

  try {
    await client.query('BEGIN');
    // A DRY RUN may install migration 615 inside its own transaction, so the
    // diff can be measured on a database the migration has not reached yet —
    // production, before anyone has deployed. Never on a --commit run: the DDL
    // would commit without a `schema_migrations` row behind it, and the next
    // real apply would then fail on a checksum it has no record of.
    const installed = await client.query(
      "SELECT to_regclass('public.ap_payment_document_backfill_candidates') IS NOT NULL AS ok",
    );
    if (!installed.rows[0]?.ok) {
      if (COMMIT) {
        throw new Error(
          'Migration 615 is not applied to this database. Apply it with `bun run db:migrate` '
          + 'before committing a backfill.',
        );
      }
      // Resolved from THIS file, not from cwd: the script is run from wherever
      // the operator happens to be standing.
      const file = join(
        dirname(fileURLToPath(import.meta.url)),
        'migrations', 'sql', '615_ap_payment_document_backfill.sql',
      );
      await client.query(readFileSync(file, 'utf8'));
      console.log('(migration 615 applied inside this transaction — it will roll back with it)');
    }
    await als.run({ client, userId: 'script:ap-backfill', claims: {} }, async () => {
      if (ROLLBACK_BATCH) {
        const res = await client.query(
          'SELECT * FROM ap_rollback_supplier_payment_document_backfill($1::UUID)',
          [ROLLBACK_BATCH],
        );
        console.log('\nROLLBACK', ROLLBACK_BATCH);
        console.log(`  deleted ${res.rows[0]?.deleted_count} payment(s), ${money(Number(res.rows[0]?.deleted_amount ?? 0))}`);
        return;
      }

      const companyId = COMPANY_ID!;
      const nameRows = await client.query('SELECT name FROM companies WHERE id = $1::UUID', [companyId]);
      if (nameRows.rows.length === 0) throw new Error(`No company ${companyId}`);
      console.log(`\n${nameRows.rows[0].name} — AP payment-document backfill, as at ${AS_AT}`);
      console.log(COMMIT ? 'MODE: COMMIT\n' : 'MODE: dry run (transaction will be rolled back)\n');

      // ── What the classification says, before anything is written ──────────
      const plan = await client.query(
        `SELECT outcome, COUNT(*)::INT AS n, COALESCE(SUM(amount), 0) AS amount
           FROM ap_payment_document_backfill_candidates
          WHERE company_id = $1::UUID GROUP BY 1 ORDER BY 2 DESC`,
        [companyId],
      );
      console.log('CANDIDATES');
      for (const r of plan.rows) {
        console.log(`  ${String(r.outcome).padEnd(24)} ${String(r.n).padStart(6)}  ${money(Number(r.amount)).padStart(18)}`);
      }
      if (plan.rows.length === 0) console.log('  (none)');

      const before = await readInvariants(companyId);
      const visBefore = await readVisible(companyId);

      const batchId = randomUUID();
      const run = await client.query(
        'SELECT * FROM ap_backfill_supplier_payment_documents($1::UUID, $2::UUID)',
        [companyId, batchId],
      );
      console.log(`\nRUN  batch ${batchId}`);
      for (const r of run.rows) {
        console.log(`  ${String(r.result_outcome).padEnd(9)} ${String(r.result_reason).padEnd(24)} ${String(r.line_count).padStart(6)}  ${money(Number(r.line_amount)).padStart(18)}`);
      }

      const after = await readInvariants(companyId);
      const visAfter = await readVisible(companyId);

      console.log('\nINVARIANTS — any Δ here is a bug, not a result');
      healthy = [
        diffLine('AP control account', before.controlBalance, after.controlBalance, true),
        diffLine('AP subledger (open bills)', before.subledgerTotal, after.subledgerTotal, true),
        diffLine('supplier_invoices.amount_paid', before.amountPaidTotal, after.amountPaidTotal, true),
        diffLine('bank GL balance', before.bank.gl, after.bank.gl, true),
        diffLine('bank statement balance', before.bank.statement, after.bank.statement, true),
        diffLine('bank computed balance', before.bank.computed, after.bank.computed, true),
        diffLine('bank gl-vs-computed difference', before.bank.difference, after.bank.difference, true),
        diffLine('bank unexplained residual', before.bank.residual, after.bank.residual, true),
      ].every(Boolean) && before.bankAccounts === after.bankAccounts;

      console.log(`\n  (${after.bankAccounts} bank accounts reconciled on both sides)`);

      console.log('\nWHAT THE BACKFILL MAKES VISIBLE');
      diffLine('unapplied supplier payments', visBefore.unappliedTotal, visAfter.unappliedTotal, false);
      console.log(`  ROWS   unapplied payment count       ${String(visBefore.unappliedRows).padStart(18)} -> ${String(visAfter.unappliedRows).padStart(18)}`);
      console.log(`  ROWS   supplier_payments rows        ${String(visBefore.paymentRows).padStart(18)} -> ${String(visAfter.paymentRows).padStart(18)}`);

      // Per supplier, largest first. This is where a name-resolution mistake
      // would show: a supplier whose created total does not match the bank
      // lines its name is on.
      const bySupplier = await client.query(
        `SELECT s.name, COUNT(*)::INT AS n, SUM(l.amount) AS amount
           FROM ap_payment_document_backfill l
           JOIN suppliers s ON s.id = l.supplier_id AND s.company_id = l.company_id
          WHERE l.batch_id = $1::UUID AND l.outcome = 'created'
          GROUP BY s.name ORDER BY SUM(l.amount) DESC LIMIT 10`,
        [batchId],
      );
      console.log('\nCREATED, BY SUPPLIER (top 10)');
      for (const r of bySupplier.rows) {
        console.log(`  ${String(r.name).slice(0, 52).padEnd(54)} ${String(r.n).padStart(4)}  ${money(Number(r.amount)).padStart(18)}`);
      }

      // The reconciliation's decomposition either side, printed in full: the
      // gap does not close (this backfill applies nothing), it MOVES from
      // "posting no document claims" to "unapplied cash with a document".
      const items = await reconcileSubledger(companyId, 'ap', AS_AT);
      console.log('\nRECONCILING ITEMS AFTER');
      for (const i of items.reconcilingItems) {
        console.log(`  ${i.bridge.padEnd(22)} ${i.type.padEnd(32)} ${money(i.amount).padStart(18)}  (${i.documentIds.length} docs)`);
      }

      if (!healthy) {
        throw new Error('An invariant moved. Refusing to commit; transaction rolled back.');
      }
    });

    if (COMMIT && healthy) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED.');
    } else {
      await client.query('ROLLBACK');
      console.log(`\nROLLED BACK${COMMIT ? ' (invariant broken)' : ' (dry run — pass --commit to keep it)'}.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('\nFAILED — rolled back.');
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
