/**
 * P2.2 backfill: set fiscal_period_id on journal entries where it is NULL or
 * mismatched (entry_date outside the linked period), using the period that
 * covers entry_date. Entries with NO covering period are REPORTED ONLY —
 * they need fiscal periods created first (operator decision).
 *
 * Usage:
 *   bun scripts/fixes/backfill-je-fiscal-periods.ts                       # dry-run, all companies
 *   bun scripts/fixes/backfill-je-fiscal-periods.ts --company <uuid>      # dry-run, one company
 *   bun scripts/fixes/backfill-je-fiscal-periods.ts --company <uuid> --apply
 *
 * HUMAN-GATED for real client books (Britech d27bac33-…): run per-company
 * with Hein's sign-off. Demo companies are in-scope for direct repair.
 * Setting the period changes which PERIOD REPORTS include the entry (that's
 * the point) — it never touches amounts, status, or the TB.
 *
 * The trg_gl_je_status_balance cache trigger only fires on status changes,
 * so after an --apply run the period-keyed gl_account_balances rows for the
 * affected (company, period) pairs are refreshed here explicitly.
 */

import pg from 'pg';

const apply = process.argv.includes('--apply');
const companyFlag = process.argv.indexOf('--company');
const companyId = companyFlag > -1 ? process.argv[companyFlag + 1] : null;
if (companyFlag > -1 && !/^[0-9a-f-]{36}$/i.test(companyId ?? '')) {
  console.error('--company requires a UUID');
  process.exit(1);
}

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const scope = companyId ? 'AND je.company_id = $1::UUID' : '';
    const params = companyId ? [companyId] : [];

    const fixable = (
      await client.query(
        `SELECT je.id, je.entry_number, je.company_id, je.entry_date, je.status,
                je.fiscal_period_id AS old_period, fp.id AS new_period, fp.period_name
         FROM gl_journal_entries je
         JOIN fiscal_periods fp
           ON fp.company_id = je.company_id
          AND je.entry_date BETWEEN fp.start_date AND fp.end_date
         LEFT JOIN fiscal_periods cur ON cur.id = je.fiscal_period_id
         WHERE (je.fiscal_period_id IS NULL
                OR je.entry_date < cur.start_date OR je.entry_date > cur.end_date)
           ${scope}
         ORDER BY je.company_id, je.entry_date`,
        params,
      )
    ).rows as Row[];

    const uncoverable = (
      await client.query(
        `SELECT je.id, je.entry_number, je.company_id, je.entry_date, je.status, je.source
         FROM gl_journal_entries je
         WHERE je.fiscal_period_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM fiscal_periods fp
             WHERE fp.company_id = je.company_id
               AND je.entry_date BETWEEN fp.start_date AND fp.end_date
           )
           ${scope}
         ORDER BY je.company_id, je.entry_date`,
        params,
      )
    ).rows as Row[];

    console.log(`Backfill JE fiscal periods — mode=${apply ? 'APPLY' : 'DRY-RUN'} scope=${companyId ?? 'all companies'}`);
    console.log(`\n[Fixable] ${fixable.length} entries (covering period exists):`);
    for (const r of fixable.slice(0, 30)) {
      console.log(`  ${String(r.entry_number).padEnd(22)} co=${String(r.company_id).slice(0, 8)} date=${String(r.entry_date).slice(0, 10)} ${r.old_period ? 'MISMATCH' : 'NULL'} -> ${r.period_name}`);
    }
    if (fixable.length > 30) console.log(`  … and ${fixable.length - 30} more`);

    console.log(`\n[Uncoverable] ${uncoverable.length} entries (no fiscal period covers entry_date — create periods first):`);
    for (const r of uncoverable.slice(0, 20)) {
      console.log(`  ${String(r.entry_number).padEnd(22)} co=${String(r.company_id).slice(0, 8)} date=${String(r.entry_date).slice(0, 10)} source=${r.source} status=${r.status}`);
    }

    if (!apply) {
      console.log('\nDRY-RUN — nothing changed. Re-run with --apply (add --company <uuid> to scope).');
      return;
    }

    await client.query('BEGIN');
    try {
      const updated = await client.query(
        `UPDATE gl_journal_entries je
         SET fiscal_period_id = fp.id
         FROM fiscal_periods fp
         WHERE fp.company_id = je.company_id
           AND je.entry_date BETWEEN fp.start_date AND fp.end_date
           AND (
             je.fiscal_period_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM fiscal_periods cur
               WHERE cur.id = je.fiscal_period_id
                 AND je.entry_date BETWEEN cur.start_date AND cur.end_date
             )
           )
           ${companyId ? 'AND je.company_id = $1::UUID' : ''}`,
        params,
      );
      if (updated.rowCount !== fixable.length) {
        throw new Error(`UPDATE touched ${updated.rowCount} rows but ${fixable.length} were planned — aborting`);
      }

      // Rebuild the period-keyed balance cache for affected companies. The
      // mig-499 trigger only fires on STATUS transitions, not period changes,
      // so recompute here using the trigger's canonical shape (the table is
      // keyed (gl_account_id, fiscal_period_id) — no company_id column;
      // tenancy is implicit via account ownership).
      const companies = [...new Set(fixable.map((r) => String(r.company_id)))];
      for (const co of companies) {
        await client.query(
          `DELETE FROM gl_account_balances
           WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1::UUID)`,
          [co],
        );
        await client.query(
          `INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
           SELECT jl.gl_account_id, je.fiscal_period_id,
                  COALESCE(SUM(jl.debit), 0), COALESCE(SUM(jl.credit), 0),
                  COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
           FROM gl_journal_lines jl
           JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
           WHERE je.company_id = $1::UUID AND je.status = 'posted'
             AND je.fiscal_period_id IS NOT NULL
           GROUP BY jl.gl_account_id, je.fiscal_period_id
           ON CONFLICT (gl_account_id, fiscal_period_id) DO UPDATE SET
             debit_total = EXCLUDED.debit_total,
             credit_total = EXCLUDED.credit_total,
             balance = EXCLUDED.balance,
             updated_at = NOW()`,
          [co],
        );
      }
      await client.query('COMMIT');
      console.log(`\nDONE. ${updated.rowCount} entries backfilled; balance cache rebuilt for ${companies.length} company(ies).`);
      console.log('Verify: bun scripts/integrity-check.ts');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('BACKFILL FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
