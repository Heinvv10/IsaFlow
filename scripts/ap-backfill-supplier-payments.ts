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
 * WHAT 681 ADDED: THE OTHER DIRECTION. A money-IN line against a supplier is a
 * REFUND — DR Bank / CR Accounts Payable — and it had no document either, for
 * the same reason and with the opposite sign. It now classifies `create_refund`
 * and mints a `supplier_payments` row with `payment_method = 'refund'` and a
 * NEGATIVE `total_amount`: a negative on-account entry that nets against that
 * supplier's other unapplied cash. Same invariants, unchanged — no journal, no
 * allocation, no `amount_paid`.
 *
 * `refund_exceeds_credit` (682) is the shape that MUST NOT be minted. A refund
 * returns credit the company was holding and cannot return more than it held;
 * past that point the supplier owes the company, which is a receivable. The
 * attended path refuses it outright, and the batch path now reports it under
 * the same ceiling — `ap_supplier_on_account_credit`, measured as at the LINE'S
 * OWN DATE, so cash applied since cannot retrospectively make a correct refund
 * wrong. It is the outcome the one production refund actually lands on: Blitz
 * Fibre held R0.00 on account on 2026-09-04 against a R160,609.85 deposit,
 * because the FIFO back-fill had already applied all 88 of its payments.
 *
 * `refund_on_control_unresolved` is the shape that CANNOT be minted. A deposit
 * allocated straight to the AP control account credits the payable without
 * naming a supplier, so there is no on-account credit for the refund to belong
 * to. It is reported, per batch, and left alone. One line on production:
 * R120,290.00 against RohCap, which somebody has to attribute by hand.
 *
 * WHAT 680 CHANGED ABOUT WHO IS REFUSED, worth knowing before reading a diff
 * against an older run's output. A cancelled payment document that carries only
 * the bank line's `reference` and NO `gl_journal_entry_id` no longer refuses its
 * line. 615 refused it under `document_cancelled_journal_stands`, but there is
 * no journal on that document to ask whether it stands, while the journal the
 * line DOES carry has moved cash no live document claims — so the refusal left
 * that cash undocumented under an outcome naming a journal that does not exist.
 * Such a line now classifies `create`. Nothing in production has this shape: no
 * cancelled `supplier_payments` row anywhere carries a null journal with a
 * non-null reference. A LIVE document with a null journal still finishes its
 * line, which is a different question — that is this backfill's own older
 * output, and it is the line's document.
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

/**
 * Every migration the classification is made of, in apply order.
 *
 * NOT just 615. The view has been replaced twice since — 679 for the bank lines
 * re-allocated after their first document was cancelled, 680 for what counts as
 * a reversal and for the uniqueness floor that let a second generation be minted
 * — and a database carrying only 615 has a view that answers the same questions
 * with the WRONG answers. Checking `to_regclass` on the view could not see that:
 * the relation exists in all three states. So the check is the tracking table,
 * per migration, and a dry run installs whichever are missing.
 *
 * Every file here is replayable — 615 is IF NOT EXISTS throughout, 679 and 680
 * are CREATE OR REPLACE — so applying one that is already present is a no-op.
 */
const VIEW_MIGRATIONS = [
  '615_ap_payment_document_backfill.sql',
  '679_ap_backfill_candidates_reallocated_lines.sql',
  '680_ap_backfill_reversal_signal_and_generation.sql',
  // 681 replaces the view AGAIN — the refund direction — and replaces the run
  // function with one that mints both. A database carrying only 680 classifies
  // every money-IN supplier line nowhere at all: the old view filtered
  // `b.amount < 0`, so the refunds were not skipped, they were invisible.
  '681_supplier_refund_documents.sql',
  // 682 puts the LIVE path's refund ceiling on the batch path too, and moves
  // the run onto a single materialised snapshot of the classification. On 681
  // alone the batch minted refunds the attended path would have refused.
  '682_ap_backfill_refund_ceiling.sql',
] as const;

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
    const tracked = await client.query(
      'SELECT name FROM schema_migrations WHERE name = ANY($1::TEXT[])',
      [[...VIEW_MIGRATIONS]],
    );
    const have = new Set(tracked.rows.map((r) => String(r.name)));
    const missing = VIEW_MIGRATIONS.filter((name) => !have.has(name));
    if (missing.length > 0) {
      if (COMMIT) {
        throw new Error(
          `Not applied to this database: ${missing.join(', ')}. Apply with `
          + '`bun run db:migrate` before committing a backfill — committing against a '
          + 'stale classification mints by rules this repo has already replaced.',
        );
      }
      // IN ORDER. 679 and 680 each replace the whole view, so applying 680
      // before 679 would leave 679's older definition standing.
      //
      // Resolved from THIS file, not from cwd: the script is run from wherever
      // the operator happens to be standing.
      for (const name of missing) {
        const file = join(dirname(fileURLToPath(import.meta.url)), 'migrations', 'sql', name);
        await client.query(readFileSync(file, 'utf8'));
      }
      console.log(
        `(applied inside this transaction, and rolling back with it: ${missing.join(', ')})`,
      );
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

      // A REFUSAL THAT UN-REFUSES ITSELF. `supplier_has_no_ledger_history`
      // reads the supplier's bills and payments at run time, so one ordinary
      // bill captured against that supplier later — by anybody, for anything —
      // silently converts the refusal into a mint on the next run, and nobody
      // revisits the identity question that caused the refusal. The refusals
      // are in the log, so the clearing can at least be SAID OUT LOUD.
      //
      // It reports across COMMITTED runs only — a dry run rolls its own log
      // rows back with everything else, so the first dry run against a tenant
      // has nothing to compare to. That is correct rather than a gap: there is
      // no earlier refusal until a run has actually refused something.
      const uncleared = await client.query(
        `SELECT DISTINCT l.bank_transaction_id::TEXT AS id, l.amount, l.reason
           FROM ap_payment_document_backfill l
           JOIN ap_payment_document_backfill_candidates c
             ON c.bank_transaction_id = l.bank_transaction_id
          WHERE l.company_id = $1::UUID
            AND l.outcome = 'skipped'
            AND l.reason = 'supplier_has_no_ledger_history'
            AND c.outcome = 'create'`,
        [companyId],
      );
      if (uncleared.rows.length > 0) {
        console.log(
          `\nPREVIOUSLY REFUSED, NOW ELIGIBLE — ${uncleared.rows.length} line(s).`
          + ' A run refused these for having no ledger history; the supplier has since'
          + ' acquired one. Nothing re-examined who the supplier is. Settle them by hand'
          + ' or accept them deliberately:',
        );
        for (const r of uncleared.rows) {
          console.log(`  ${r.id}  ${money(Number(r.amount)).padStart(18)}`);
        }
      }

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

      // EVERY supplier, and every column an operator needs to spot a wrong one.
      //
      // This block is the ONLY human control over the one defect this design
      // cannot close in SQL. `bank_transactions` carries no supplier id, so the
      // supplier is resolved by NAME, and a supplier renamed with its old name
      // reused makes "exactly one match" the wrong row with no independent
      // witness (see the view's own note). `supplier_has_no_ledger_history`
      // narrows that to suppliers with nothing else in the tenant — an impostor
      // needs exactly one bill to get past it.
      //
      // So it is printed IN FULL and grouped by supplier ID, not name. It was
      // `LIMIT 10 ORDER BY amount DESC`, which showed ten rows of six hundred
      // and put the largest first — and the odd shapes are the SMALL ones: the
      // nine lines this run refuses for no history total R1,795.50 between
      // them. Nothing puts an impostor in a top ten by amount.
      //
      // `bills` and `first_seen` are the eyeball columns. A supplier taking
      // R50,000 of backfilled cash on the strength of one R250 bill is the
      // demonstrated attack, and it is visible here or nowhere.
      const bySupplier = await client.query(
        `SELECT s.id::TEXT AS supplier_id, s.name, COUNT(*)::INT AS n, SUM(l.amount) AS amount,
                (SELECT COUNT(*) FROM supplier_invoices si
                  WHERE si.company_id = l.company_id AND si.supplier_id = s.id)::INT AS bills,
                MIN(s.created_at)::DATE::TEXT AS supplier_created,
                MIN(b.transaction_date)::TEXT AS earliest_line
           FROM ap_payment_document_backfill l
           JOIN suppliers s ON s.id = l.supplier_id AND s.company_id = l.company_id
           JOIN bank_transactions b ON b.id = l.bank_transaction_id
          WHERE l.batch_id = $1::UUID AND l.outcome = 'created'
          GROUP BY s.id, s.name, l.company_id ORDER BY s.name`,
        [batchId],
      );
      // Refunds are `created` too, so they are in this list with the rest and
      // their `amount` is the GROSS line value — the log stores it unsigned so a
      // batch summary can be read down one column. The reason column on the RUN
      // block above (`backfilled` vs `backfilled_refund`) is what separates them.
      console.log(`\nCREATED, BY SUPPLIER — all ${bySupplier.rows.length}. READ THIS LIST.`);
      console.log(`  ${'supplier'.padEnd(46)} ${'lines'.padStart(5)} ${'amount'.padStart(18)} ${'bills'.padStart(5)}  created / earliest line`);
      for (const r of bySupplier.rows) {
        const flagged = Number(r.bills) <= 1 ? ' <-- CHECK' : '';
        console.log(
          `  ${String(r.name).slice(0, 44).padEnd(46)} ${String(r.n).padStart(5)} `
          + `${money(Number(r.amount)).padStart(18)} ${String(r.bills).padStart(5)}  `
          + `${r.supplier_created} / ${r.earliest_line}  ${r.supplier_id}${flagged}`,
        );
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
