/**
 * ISAFlow Accounting Integrity Check
 *
 * Runs comprehensive double-entry accounting sanity checks against the live DB.
 * Usage: npx tsx scripts/integrity-check.ts
 */
import { createSql } from './_pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------
const envPath = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in environment or .env.local');
  process.exit(1);
}

const sql = createSql();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number | string): string {
  const num = typeof n === 'string' ? parseFloat(n) : n;
  return `R${num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

let passed = 0;
let total = 0;

function pass(label: string, detail: string): void {
  console.log(`[PASS] ${label} — ${detail}`);
  passed++;
  total++;
}

function fail(label: string, detail: string): void {
  console.log(`[FAIL] ${label} — ${detail}`);
  total++;
}

function indent(s: string): void {
  console.log(`  ${s}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== ISAFlow Accounting Integrity Check ===\n');

  // -------------------------------------------------------------------------
  // Check 1 — Journal Entry Balance (per entry)
  // -------------------------------------------------------------------------
  {
    const rows = (await sql`
      SELECT je.id, je.entry_number, je.company_id, je.entry_date,
             SUM(jl.debit)  AS total_debit,
             SUM(jl.credit) AS total_credit,
             ABS(SUM(jl.debit) - SUM(jl.credit)) AS imbalance
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.status = 'posted'
      GROUP BY je.id, je.entry_number, je.company_id, je.entry_date
      HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
      ORDER BY imbalance DESC
      LIMIT 20
    `) as Array<{
      id: string;
      entry_number: string | null;
      company_id: string;
      entry_date: string;
      total_debit: string;
      total_credit: string;
      imbalance: string;
    }>;

    if (rows.length === 0) {
      pass('JE balance (per entry)', '0 unbalanced entries');
    } else {
      fail('JE balance (per entry)', `${rows.length} unbalanced entr${rows.length === 1 ? 'y' : 'ies'}`);
      for (const r of rows) {
        indent(
          `entry=${r.entry_number ?? r.id}  company=${r.company_id.slice(0, 8)}  ` +
          `date=${r.entry_date}  dr=${fmt(r.total_debit)}  cr=${fmt(r.total_credit)}  off=${fmt(r.imbalance)}`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Check 2 — Overall TB balance per company
  // -------------------------------------------------------------------------
  {
    const rows = (await sql`
      SELECT je.company_id,
             ROUND(SUM(jl.debit)::numeric,  2) AS total_debits,
             ROUND(SUM(jl.credit)::numeric, 2) AS total_credits,
             ROUND(ABS(SUM(jl.debit) - SUM(jl.credit))::numeric, 2) AS imbalance
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.status = 'posted'
      GROUP BY je.company_id
      HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
    `) as Array<{
      company_id: string;
      total_debits: string;
      total_credits: string;
      imbalance: string;
    }>;

    if (rows.length === 0) {
      pass('Overall TB balance (per company)', '0 companies with imbalance');
    } else {
      fail('Overall TB balance (per company)', `${rows.length} compan${rows.length === 1 ? 'y' : 'ies'} with imbalance`);
      for (const r of rows) {
        indent(
          `company_id=${r.company_id.slice(0, 8)}  debits=${fmt(r.total_debits)}  ` +
          `credits=${fmt(r.total_credits)}  off=${fmt(r.imbalance)}`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Check 3 — Orphaned journal lines
  // -------------------------------------------------------------------------
  {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_journal_lines jl
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.id IS NULL
    `) as Array<{ cnt: number }>;

    const cnt = row?.cnt ?? 0;
    if (cnt === 0) {
      pass('Orphaned journal lines', '0 lines without a parent JE');
    } else {
      fail('Orphaned journal lines', `${cnt} line${cnt === 1 ? '' : 's'} have no parent JE`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 4 — Journal lines referencing invalid GL accounts
  // -------------------------------------------------------------------------
  {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_journal_lines jl
      LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE ga.id IS NULL
    `) as Array<{ cnt: number }>;

    const cnt = row?.cnt ?? 0;
    if (cnt === 0) {
      pass('JE lines → valid GL accounts', '0 lines with missing GL account');
    } else {
      fail('JE lines → valid GL accounts', `${cnt} line${cnt === 1 ? '' : 's'} reference a non-existent GL account`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 5 — Bank transactions referencing invalid bank accounts
  // -------------------------------------------------------------------------
  {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM bank_transactions bt
      LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
      WHERE ga.id IS NULL
    `) as Array<{ cnt: number }>;

    const cnt = row?.cnt ?? 0;
    if (cnt === 0) {
      pass('Bank txns → valid bank accounts', '0 transactions with missing bank account');
    } else {
      fail('Bank txns → valid bank accounts', `${cnt} transaction${cnt === 1 ? '' : 's'} reference a non-existent GL account`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 6 — Duplicate journal entry numbers per company
  // -------------------------------------------------------------------------
  {
    const rows = (await sql`
      SELECT company_id, entry_number, COUNT(*)::int AS cnt
      FROM gl_journal_entries
      WHERE entry_number IS NOT NULL
      GROUP BY company_id, entry_number
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 10
    `) as Array<{ company_id: string; entry_number: string; cnt: number }>;

    if (rows.length === 0) {
      pass('Duplicate JE numbers', '0 duplicate entry numbers per company');
    } else {
      const total_dups = rows.reduce((s, r) => s + r.cnt, 0);
      fail('Duplicate JE numbers', `${rows.length} duplicate group${rows.length === 1 ? '' : 's'} (${total_dups} entries involved)`);
      for (const r of rows) {
        indent(`company=${r.company_id.slice(0, 8)}  entry_number=${r.entry_number}  count=${r.cnt}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Check 7 — Reconciled bank txns with no matched journal line
  // -------------------------------------------------------------------------
  {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM bank_transactions
      WHERE status = 'reconciled' AND matched_journal_line_id IS NULL
    `) as Array<{ cnt: number }>;

    const cnt = row?.cnt ?? 0;
    if (cnt === 0) {
      pass('Reconciled txns have journal match', '0 reconciled transactions missing a journal line');
    } else {
      fail(
        'Reconciled txns have journal match',
        `${cnt} reconciled transaction${cnt === 1 ? '' : 's'} have no matched_journal_line_id`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Check 8 — GL accounts with invalid parent references
  // -------------------------------------------------------------------------
  {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_accounts ga
      WHERE ga.parent_account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gl_accounts p WHERE p.id = ga.parent_account_id)
    `) as Array<{ cnt: number }>;

    const cnt = row?.cnt ?? 0;
    if (cnt === 0) {
      pass('GL account parent refs', '0 accounts with a broken parent reference');
    } else {
      fail('GL account parent refs', `${cnt} account${cnt === 1 ? '' : 's'} point to a non-existent parent`);
    }
  }

  // -------------------------------------------------------------------------
  // Check 9 — Company-level summary stats (informational, always passes)
  // -------------------------------------------------------------------------
  {
    console.log('');
    console.log('[INFO] Company-level summary stats:');

    const companies = (await sql`
      SELECT id, name FROM companies WHERE is_active = true ORDER BY name
    `) as Array<{ id: string; name: string }>;

    if (companies.length === 0) {
      indent('(no active companies found)');
    } else {
      for (const co of companies) {
        const [stats] = (await sql`
          SELECT
            (SELECT COUNT(*)::int FROM gl_journal_entries WHERE company_id = ${co.id}::UUID AND status = 'posted') AS posted_jes,
            (SELECT COUNT(*)::int FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
               WHERE je.company_id = ${co.id}::UUID AND je.status = 'posted') AS je_lines,
            (SELECT COUNT(*)::int FROM bank_transactions WHERE company_id = ${co.id}::UUID) AS bank_txns,
            (SELECT COUNT(*)::int FROM bank_categorisation_rules WHERE company_id = ${co.id}::UUID) AS bank_rules
        `) as Array<{
          posted_jes: number;
          je_lines: number;
          bank_txns: number;
          bank_rules: number;
        }>;

        if (stats) {
          indent(
            `${co.name.padEnd(30)}  JEs=${String(stats.posted_jes).padStart(6)}  ` +
            `lines=${String(stats.je_lines).padStart(7)}  ` +
            `bank_txns=${String(stats.bank_txns).padStart(6)}  ` +
            `bank_rules=${String(stats.bank_rules).padStart(4)}`
          );
        }
      }
    }

    // Check 9 is informational — always counts as passed
    passed++;
    total++;
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('');
  console.log(`=== SUMMARY: ${passed}/${total} checks passed ===`);

  if (passed < total) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
