#!/usr/bin/env node
/**
 * Audit helper: run EXPLAIN (ANALYZE, BUFFERS) on the primary SQL of the slowest
 * endpoints identified by perf-autocannon.sh. Read-only, outputs to stdout.
 *
 * Usage: node scripts/audit-2026-04-14/perf-explain.mjs
 * Requires: DATABASE_URL exported from .env.local
 */
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const C = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'; // Brightsphere

async function explain(label, query) {
  console.log(`\n=== ${label} ===`);
  const plan = await sql.query(`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
  console.log(plan.map((r) => r['QUERY PLAN']).join('\n'));
}

await explain(
  'bank-transactions (list, company-scoped)',
  `SELECT bt.*, ga.account_name AS bank_account_name
   FROM bank_transactions bt
   LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
   WHERE bt.company_id = '${C}'
   ORDER BY bt.transaction_date DESC, bt.amount DESC
   LIMIT 50`
);

await explain(
  'supplier-invoices (list)',
  `SELECT si.*, s.name AS supplier_name
   FROM supplier_invoices si
   LEFT JOIN suppliers s ON s.id = si.supplier_id
   WHERE si.company_id = '${C}'::UUID AND si.deleted_at IS NULL
   ORDER BY si.invoice_date DESC LIMIT 50`
);

await explain(
  'reports-journal-entries (grouped)',
  `SELECT je.id, je.entry_number, je.entry_date,
          COALESCE(SUM(jl.debit),0) AS td,
          COALESCE(SUM(jl.credit),0) AS tc
   FROM gl_journal_entries je
   LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
   WHERE je.company_id = '${C}'::UUID
   GROUP BY je.id, je.entry_number, je.entry_date
   ORDER BY je.entry_date DESC
   LIMIT 200`
);

await explain(
  'cash-flow net-income (one of 6 queries)',
  `SELECT COALESCE(SUM(CASE WHEN ga.account_type='revenue' THEN jl.credit - jl.debit ELSE 0 END),0)::numeric
   - COALESCE(SUM(CASE WHEN ga.account_type='expense' THEN jl.debit - jl.credit ELSE 0 END),0)::numeric AS net_income
   FROM gl_journal_lines jl
   JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
   JOIN gl_accounts ga ON ga.id = jl.gl_account_id
   WHERE je.status='posted' AND je.company_id='${C}'::UUID
     AND je.entry_date >= '2026-01-01' AND je.entry_date <= '2026-04-14'
     AND ga.account_type IN ('revenue','expense')`
);
