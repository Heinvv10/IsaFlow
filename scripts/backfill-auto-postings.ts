/**
 * Backfill auto-postings for seeded historical records.
 *
 * The ISAFlow demo DB contains ~565 customer invoices, ~550 supplier bills and
 * 98 payroll runs that were inserted directly via SQL seed migrations without
 * going through the API's auto-posting path. As a result, gl_journal_entry_id
 * is NULL on every record and 2024 reports come out empty.
 *
 * This script walks those records and calls the existing auto-posting services
 * to create the missing journal entries. It is idempotent — records that
 * already have a gl_journal_entry_id are skipped.
 *
 * Usage:
 *   npx tsx scripts/backfill-auto-postings.ts --company <companyId>             # dry-run
 *   npx tsx scripts/backfill-auto-postings.ts --company <companyId> --commit    # live
 *   npx tsx scripts/backfill-auto-postings.ts --company <companyId> --commit --from 2024-01-01 --to 2024-12-31
 */

import { createSql } from './_pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env loading (mirror integrity-check.ts)
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

// Backfill writes to company-scoped tables and must bypass RLS.
// Prefer MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS role); fall back to DATABASE_URL.
if (!process.env.MIGRATION_ADMIN_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL missing. Create .env.local or export it.');
  process.exit(1);
}

const sql = createSql(process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const commit = args.includes('--commit');
const companyId = getArg('--company');
const fromDate = getArg('--from') ?? '1900-01-01';
const toDate = getArg('--to') ?? '2099-12-31';
const onlyKind = getArg('--only') as 'invoices' | 'bills' | 'payroll' | undefined;

if (!companyId) {
  console.error('Usage: backfill-auto-postings --company <id> [--commit] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--only invoices|bills|payroll]');
  process.exit(1);
}

console.log(
  `\nBackfill auto-postings — company=${companyId} mode=${commit ? 'COMMIT' : 'DRY-RUN'} range=${fromDate}..${toDate}${onlyKind ? ` only=${onlyKind}` : ''}\n`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

/**
 * Coerce a DB value to an ISO YYYY-MM-DD string, regardless of whether
 * neon returns a Date object, a full timestamp string, or an ISO date string.
 */
function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Cannot coerce to ISO date: ${s}`);
}

async function resolveAccount(code: string): Promise<{ id: string }> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ${code}
    LIMIT 1
  `) as Row[];
  if (!rows[0]) throw new Error(`Required account ${code} not found for company ${companyId} — run migration 347 first`);
  return { id: String(rows[0].id) };
}

async function resolveFiscalPeriod(date: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID
      AND ${date}::DATE BETWEEN start_date AND end_date
    LIMIT 1
  `) as Row[];
  return rows[0] ? String(rows[0].id) : null;
}

async function nextEntryNumber(yearHint: number): Promise<string> {
  const rows = (await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
    FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND entry_number ~ ${`^JE-${yearHint}-[0-9]+$`}
  `) as Row[];
  const next = Number(rows[0]?.max_num ?? 0) + 1;
  return `JE-${yearHint}-${String(next).padStart(5, '0')}`;
}

async function postEntry(
  entryDate: string,
  description: string,
  source: string,
  sourceDocumentId: string,
  lines: Array<{ accountId: string; debit: number; credit: number; note: string }>,
): Promise<string | null> {
  const totalDR = lines.reduce((s, l) => s + l.debit, 0);
  const totalCR = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDR - totalCR) > 0.01) {
    throw new Error(`Unbalanced entry for ${source} ${sourceDocumentId}: DR=${totalDR} CR=${totalCR}`);
  }

  if (!commit) return null;

  const year = new Date(entryDate).getFullYear();
  const entryNumber = await nextEntryNumber(year);
  const fiscalPeriodId = await resolveFiscalPeriod(entryDate);

  const entryRows = (await sql`
    INSERT INTO gl_journal_entries (
      company_id, entry_number, entry_date, fiscal_period_id,
      description, source, source_document_id, status,
      posted_at, created_by
    ) VALUES (
      ${companyId}::UUID, ${entryNumber}, ${entryDate}::DATE, ${fiscalPeriodId},
      ${description}, ${source}, ${sourceDocumentId}::UUID, 'posted',
      NOW(), ${'00000000-0000-0000-0000-000000000001'}::UUID
    )
    RETURNING id
  `) as Row[];
  const entryId = String(entryRows[0]!.id);

  for (const line of lines) {
    await sql`
      INSERT INTO gl_journal_lines (
        company_id, journal_entry_id, gl_account_id, debit, credit, description
      ) VALUES (
        ${companyId}::UUID, ${entryId}::UUID, ${line.accountId}::UUID,
        ${line.debit}, ${line.credit}, ${line.note}
      )
    `;
  }

  return entryId;
}

// ---------------------------------------------------------------------------
// Invoice backfill (AR)
// ---------------------------------------------------------------------------
async function backfillCustomerInvoices() {
  const ar = await resolveAccount('1120');
  const vatOut = await resolveAccount('2120');
  const defaultRev = await resolveAccount('4100'); // Activation Revenue

  const invoices = (await sql`
    SELECT id, invoice_number, invoice_date, subtotal, tax_amount, total_amount
    FROM customer_invoices
    WHERE company_id = ${companyId}::UUID
      AND status IN ('approved','sent','paid','partially_paid','overdue')
      AND gl_journal_entry_id IS NULL
      AND invoice_date BETWEEN ${fromDate}::DATE AND ${toDate}::DATE
    ORDER BY invoice_date
  `) as Row[];

  console.log(`\n[Customer invoices] ${invoices.length} candidates`);
  let ok = 0, err = 0;
  for (const inv of invoices) {
    try {
      const lines: Array<{ accountId: string; debit: number; credit: number; note: string }> = [
        { accountId: ar.id, debit: Number(inv.total_amount), credit: 0, note: `AR: ${inv.invoice_number}` },
        { accountId: defaultRev.id, debit: 0, credit: Number(inv.subtotal), note: `Revenue: ${inv.invoice_number}` },
      ];
      if (Number(inv.tax_amount) > 0) {
        lines.push({ accountId: vatOut.id, debit: 0, credit: Number(inv.tax_amount), note: `VAT Output: ${inv.invoice_number}` });
      }
      const entryId = await postEntry(
        toIsoDate(inv.invoice_date),
        `Customer invoice ${inv.invoice_number}`,
        'auto_invoice',
        String(inv.id),
        lines,
      );
      if (commit && entryId) {
        await sql`
          UPDATE customer_invoices SET gl_journal_entry_id = ${entryId}::UUID
          WHERE id = ${inv.id}::UUID AND company_id = ${companyId}::UUID
        `;
      }
      ok++;
    } catch (e) {
      err++;
      console.error(`  FAIL invoice ${inv.invoice_number}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`  ${commit ? 'posted' : 'would post'} ${ok}, errors ${err}`);
}

// ---------------------------------------------------------------------------
// Bill backfill (AP)
// ---------------------------------------------------------------------------
async function backfillSupplierInvoices() {
  const ap = await resolveAccount('2110');
  const vatIn = await resolveAccount('1140');
  const defaultExp = await resolveAccount('5100'); // Materials & Supplies

  const bills = (await sql`
    SELECT id, invoice_number, invoice_date, subtotal, tax_amount, total_amount
    FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID
      AND status IN ('approved','partially_paid','paid')
      AND gl_journal_entry_id IS NULL
      AND invoice_date BETWEEN ${fromDate}::DATE AND ${toDate}::DATE
    ORDER BY invoice_date
  `) as Row[];

  console.log(`\n[Supplier bills] ${bills.length} candidates`);
  let ok = 0, err = 0;
  for (const bill of bills) {
    try {
      // Load items so we can use their gl_account_id if set.
      // Important: seed-data `line_total` is VAT-inclusive, so derive the
      // ex-VAT expense amount from (line_total - tax_amount) to avoid
      // double-counting VAT in the debit side.
      const items = (await sql`
        SELECT description, line_total, tax_amount, gl_account_id
        FROM supplier_invoice_items
        WHERE supplier_invoice_id = ${bill.id}::UUID
      `) as Row[];

      const lines: Array<{ accountId: string; debit: number; credit: number; note: string }> = [];
      let exVatSum = 0;
      for (const it of items) {
        const exVat = Number(it.line_total) - Number(it.tax_amount || 0);
        exVatSum += exVat;
        if (exVat > 0) {
          lines.push({
            accountId: it.gl_account_id ? String(it.gl_account_id) : defaultExp.id,
            debit: exVat,
            credit: 0,
            note: String(it.description || bill.invoice_number),
          });
        }
      }
      // If item breakdown differs from header subtotal (rounding), absorb the
      // residual into the default-expense account to keep the entry balanced.
      const subtotal = Number(bill.subtotal);
      const residual = Math.round((subtotal - exVatSum) * 100) / 100;
      if (Math.abs(residual) > 0.01) {
        lines.push({ accountId: defaultExp.id, debit: residual, credit: 0, note: `Rounding: ${bill.invoice_number}` });
      }
      if (Number(bill.tax_amount) > 0) {
        lines.push({ accountId: vatIn.id, debit: Number(bill.tax_amount), credit: 0, note: `VAT Input: ${bill.invoice_number}` });
      }
      lines.push({ accountId: ap.id, debit: 0, credit: Number(bill.total_amount), note: `AP: ${bill.invoice_number}` });

      const entryId = await postEntry(
        toIsoDate(bill.invoice_date),
        `Supplier bill ${bill.invoice_number}`,
        'auto_supplier_invoice',
        String(bill.id),
        lines,
      );
      if (commit && entryId) {
        await sql`
          UPDATE supplier_invoices SET gl_journal_entry_id = ${entryId}::UUID
          WHERE id = ${bill.id}::UUID AND company_id = ${companyId}::UUID
        `;
      }
      ok++;
    } catch (e) {
      err++;
      console.error(`  FAIL bill ${bill.invoice_number}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`  ${commit ? 'posted' : 'would post'} ${ok}, errors ${err}`);
}

// ---------------------------------------------------------------------------
// Payroll backfill
// ---------------------------------------------------------------------------
async function backfillPayrollRuns() {
  const wages = await resolveAccount('5200');
  const paye = await resolveAccount('2140');
  const uif = await resolveAccount('2150');
  const sdl = await resolveAccount('2160');
  const netSal = await resolveAccount('2170');

  const runs = (await sql`
    SELECT id, period_start, period_end,
           total_gross, total_paye, total_uif_employee, total_uif_employer, total_sdl, total_net
    FROM payroll_runs
    WHERE company_id = ${companyId}::UUID
      AND status = 'completed'
      AND journal_entry_id IS NULL
      AND period_end BETWEEN ${fromDate}::DATE AND ${toDate}::DATE
    ORDER BY period_end
  `) as Row[];

  console.log(`\n[Payroll runs] ${runs.length} candidates`);
  let ok = 0, err = 0;
  for (const run of runs) {
    try {
      const gross = Number(run.total_gross);
      const p = Number(run.total_paye);
      const uifEE = Number(run.total_uif_employee);
      const uifER = Number(run.total_uif_employer);
      const s = Number(run.total_sdl);
      const net = Number(run.total_net);

      // DR: Wages gross + Employer UIF + SDL (company cost)
      // CR: PAYE Payable + UIF Payable (both halves) + SDL Payable + Net Salaries Payable
      const lines = [
        { accountId: wages.id, debit: gross + uifER + s, credit: 0, note: 'Wages + employer contributions' },
        { accountId: paye.id,  debit: 0, credit: p,   note: 'PAYE withheld' },
        { accountId: uif.id,   debit: 0, credit: uifEE + uifER, note: 'UIF employee + employer' },
        { accountId: sdl.id,   debit: 0, credit: s,   note: 'SDL' },
        { accountId: netSal.id, debit: 0, credit: net, note: 'Net salaries payable' },
      ];

      const entryId = await postEntry(
        toIsoDate(run.period_end),
        `Payroll ${toIsoDate(run.period_start)}..${toIsoDate(run.period_end)}`,
        'auto_payroll',
        String(run.id),
        lines,
      );
      if (commit && entryId) {
        await sql`
          UPDATE payroll_runs SET journal_entry_id = ${entryId}::UUID
          WHERE id = ${run.id}::UUID AND company_id = ${companyId}::UUID
        `;
      }
      ok++;
    } catch (e) {
      err++;
      console.error(`  FAIL payroll run ${run.id}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`  ${commit ? 'posted' : 'would post'} ${ok}, errors ${err}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    if (!onlyKind || onlyKind === 'invoices') await backfillCustomerInvoices();
    if (!onlyKind || onlyKind === 'bills')    await backfillSupplierInvoices();
    if (!onlyKind || onlyKind === 'payroll')  await backfillPayrollRuns();

    if (!commit) {
      console.log('\nDry-run complete. Re-run with --commit to post journal entries.');
    } else {
      console.log('\nBackfill complete. Trial Balance / Income Statement / VAT201 for the affected periods will now populate.');
    }
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  }
})();
