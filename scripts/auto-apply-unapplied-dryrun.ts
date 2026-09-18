/**
 * What the back-fill WOULD apply, for an operator to read before anyone runs it.
 *
 *   bun scripts/auto-apply-unapplied-dryrun.ts --company <uuid> --subledger ap
 *   bun scripts/auto-apply-unapplied-dryrun.ts --company <uuid> --subledger ar \
 *     --entity <uuid> --limit 100 --out /tmp/plan.json
 *
 * THIS SCRIPT CANNOT RUN LIVE. There is no --commit and no --live: it calls the
 * service with `dryRun: true` and nothing else, and the whole run happens inside
 * a transaction that is ROLLED BACK unconditionally at the end. The open-document
 * reads take FOR UPDATE row locks, and the rollback is what releases them
 * promptly rather than at the end of an implicit statement.
 *
 * AND IT REFUSES PRODUCTION, through the same allow-list guard the mutating
 * tests use rather than a second copy of it — dev, staging and production
 * differ only in the database NAME on one host, which is a very small env slip
 * to make. `isaflow_dev`, `isaflow_test` and `isaflow_staging` are allowed;
 * `isaflow` is not, and no flag reaches past that.
 *
 * The live run is `auto_apply_unapplied` with `dry_run: false`, which applies
 * each payment in its own savepoint and is reversible per payment.
 */
import pg from 'pg';
import { writeFileSync } from 'fs';
import { als } from '@/lib/als';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { SUBLEDGERS, type Subledger } from '@/modules/accounting/services/shared/autoApplyBackfillPlan';
import { assertNotProductionDb } from '../tests/helpers/assertNotProductionDb';

const argv = process.argv.slice(2);

/** A flag's value, refusing to read the NEXT FLAG as one. */
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value (got ${value ?? 'nothing'}).`);
  }
  return value;
}

const money = (n: number): string =>
  `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : text.padStart(width);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  assertNotProductionDb('This script reads and row-locks a whole subledger.');

  const companyId = flag('company');
  const subledger = flag('subledger');
  if (!companyId) throw new Error('--company <uuid> is required (this is a per-tenant remedy)');
  if (!subledger || !(SUBLEDGERS as readonly string[]).includes(subledger)) {
    throw new Error(`--subledger must be one of ${SUBLEDGERS.join(', ')}`);
  }
  const entityId = flag('entity') ?? null;
  const limit = Number(flag('limit') ?? 500);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive number');
  const out = flag('out') ?? `auto-apply-unapplied-${subledger}-${companyId}.json`;

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await als.run(
      { client, userId: 'script:auto-apply-dryrun', companyId, claims: {} } as never,
      () => autoApplyUnapplied({
        companyId,
        userId: 'script:auto-apply-dryrun',
        subledger: subledger as Subledger,
        entityId,
        dryRun: true,
        limit: Math.floor(limit),
      }),
    );

    console.log(`\n${subledger.toUpperCase()} back-fill — DRY RUN, company ${companyId}`);
    console.log(`${plan.processed} source(s) considered, ${plan.applications.length} would apply\n`);

    console.log(`${pad('PAYMENT', 20)}${pad('CONTACT', 28)}${pad('DATE', 12)}`
      + `${padLeft('REMAINDER', 14)}${padLeft('APPLIED', 14)}${padLeft('ON ACCOUNT', 14)}  DOCS`);
    for (const a of plan.applications) {
      const applied = a.remainder_before - a.on_account_after;
      console.log(
        pad(a.payment_number || a.payment_id, 20)
        + pad(a.entity_name, 28)
        + pad(a.payment_date, 12)
        + padLeft(money(a.remainder_before), 14)
        + padLeft(money(applied), 14)
        + padLeft(money(a.on_account_after), 14)
        + `  ${a.lines.map((l) => `${l.document_number}:${money(l.amount)}`).join(' ')}`,
      );
    }

    // REPORTED SEPARATELY AND FIRST AMONG THE TOTALS. In production this list is
    // the larger half — cash with nothing open to settle is a question for a
    // human, not something the back-fill can close.
    console.log(`\nNO OPEN DOCUMENTS — ${plan.totals.payments_with_no_open_documents} source(s), `
      + `${money(plan.totals.no_open_documents_amount)}`);
    for (const r of plan.no_open_documents) {
      console.log(
        `  ${pad(r.payment_number || r.payment_id, 20)}${pad(r.entity_name, 28)}`
        + `${pad(r.payment_date, 12)}${padLeft(money(r.amount), 14)}`
        + (r.skipped_reason ? `  (${r.skipped_reason})` : ''),
      );
    }

    console.log(`\nWOULD APPLY        ${money(plan.totals.applied)}`);
    console.log(`LEFT ON ACCOUNT    ${money(plan.totals.left_on_account)}`);
    console.log(`NO OPEN DOCUMENTS  ${money(plan.totals.no_open_documents_amount)}`);

    writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`\nPlan written to ${out}`);
  } finally {
    // UNCONDITIONAL. There is no path through this script that commits.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

await main();
