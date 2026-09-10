/**
 * simulate-fy2026-workflows.ts — v2, calls the real services
 *
 * Drives FY2026 (Jan–Dec 2026) end-to-end through the actual
 * service layer rather than inline SQL. One iteration per month:
 *
 *   closeLoanPeriod          (loans — reclass LT → current portion)
 *   recordLoanPayment        (loans — apply scheduled payment, reduces principal)
 *   generateWipInvoice       (practice — approved+unbilled time entries → invoice)
 *   approvePayrollRun        (payroll — posts GL journal)
 *   markUifDeclarationPaid   (payroll — clears UIF Payable when paid)
 *   submitVATReturn          (reports — bi-monthly; Feb/Apr/Jun/Aug/Oct/Dec)
 *
 * Per-module try/catch so one failure doesn't kill the loop.
 * Fully idempotent — re-runs skip already-done work.
 *
 * Run:
 *   export $(sudo grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' /home/velo/isaflow/.env.local | xargs)
 *   npx tsx scripts/simulate-fy2026-workflows.ts
 */

import { closeSql } from './_pg';
import { randomUUID } from 'crypto';

// Real services — via relative paths. tsx resolves the @/ aliases
// inside these files via the root tsconfig paths.
import { generateWipInvoice } from '../src/modules/accounting/services/practice/practiceWipService';
import { approvePayrollRun } from '../src/modules/accounting/services/payroll/payrollApprovalService';
import {
  createPayrollRun,
  calculatePayrollRun,
} from '../src/modules/accounting/services/payroll/payrollRunService';
import {
  generateUifDeclaration,
  markUifSubmitted,
  markUifDeclarationPaid,
} from '../src/modules/accounting/services/payroll/uifDeclarationService';
import { submitVATReturn } from '../src/modules/accounting/services/reports/vatSubmissionService';
import { closeLoansPool, runLoanPayments, runLoansClose } from './simulate-fy2026-loans';
import type { Err } from './simulate-fy2026-context';
import { ADMIN_ID, COMPANY_ID, errText, firstDay, lastDay, pad, sql, yyyymm } from './simulate-fy2026-context';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const VAT_MONTHS  = new Set([2, 4, 6, 8, 10, 12]);

// ── PREREQ: link each practice_client to a customer ─────────────────────────

async function linkPracticeClients(): Promise<void> {
  const clients = await sql.query<{id:string;legal_name:string;link_customer_id:string|null}>(
    `SELECT id,legal_name,link_customer_id FROM practice_clients WHERE company_id=$1 AND status='active'`,
    [COMPANY_ID],
  );
  let linked = 0;
  for (const c of clients) {
    if (c.link_customer_id) continue;
    const cid = randomUUID();
    await sql.query(
      `INSERT INTO customers (id,company_id,name,is_active,created_at,updated_at)
       VALUES ($1,$2,$3,true,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [cid, COMPANY_ID, c.legal_name],
    );
    await sql.query(`UPDATE practice_clients SET link_customer_id=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3`, [cid, c.id, COMPANY_ID]);
    linked++;
  }
  console.log(`[PREREQ] ${linked} practice→customer links created (${clients.length - linked} already set)\n`);
}

// ── MODULES ──────────────────────────────────────────────────────────────────

async function runPracticeWip(month: number, year: number, errors: Err[]): Promise<number> {
  let created = 0;
  try {
    const clients = await sql.query<{id:string;legal_name:string}>(
      `SELECT id, legal_name FROM practice_clients
       WHERE company_id=$1 AND status='active' AND link_customer_id IS NOT NULL`,
      [COMPANY_ID],
    );
    for (const c of clients) {
      const entries = await sql.query<{id:string}>(
        `SELECT id FROM time_entries
         WHERE company_id=$1 AND practice_client_id=$2
           AND status='approved' AND billed_at IS NULL AND billable=true
           AND entry_date >= $3::DATE AND entry_date <= $4::DATE`,
        [COMPANY_ID, c.id, firstDay(year, month), lastDay(year, month)],
      );
      if (!entries.length) continue;
      try {
        const result = await generateWipInvoice(COMPANY_ID, ADMIN_ID, {
          practiceClientId: c.id,
          timeEntryIds: entries.map(e => e.id),
          taxRate: 15,
        });
        console.log(`  [wip] ${c.legal_name}: ${entries.length} entries → invoice ${result.invoiceNumber} subtotal R${result.subtotal.toFixed(2)} VAT R${result.taxAmount.toFixed(2)} total R${result.totalAmount.toFixed(2)}`);
        created++;
      } catch (err) {
        errors.push({ month, module: 'wip', message: `${c.legal_name}: ${errText(err)}` });
        console.error(`  [wip] ERROR ${c.legal_name}: ${errText(err)}`);
      }
    }
    if (created === 0) console.log(`  [wip] no billable entries for ${yyyymm(year, month)} — skip`);
  } catch (err) {
    errors.push({ month, module: 'wip', message: errText(err) });
  }
  return created;
}

async function runPayrollApprove(month: number, year: number, errors: Err[]): Promise<string | null> {
  try {
    const existing = await sql.query<{id:string;status:string;journal_entry_id:string|null}>(
      `SELECT id, status, journal_entry_id FROM payroll_run_headers
       WHERE company_id=$1 AND period_year=$2 AND period_month=$3 LIMIT 1`,
      [COMPANY_ID, year, month],
    );
    let runId: string;
    if (existing[0]) {
      runId = existing[0].id;
      if (existing[0].journal_entry_id) {
        console.log(`  [payroll] run ${runId.slice(0,8)} already has JE — skip`);
        return runId;
      }
      if (existing[0].status === 'approved') {
        // approved but no JE — force-approve via the service to post the missing journal
      }
    } else {
      // Create + calculate new run for this period
      const run = await createPayrollRun(COMPANY_ID, { year, month }, ADMIN_ID);
      runId = run.id;
      await calculatePayrollRun(runId, COMPANY_ID);
    }
    const approved = await approvePayrollRun(COMPANY_ID, runId, ADMIN_ID);
    console.log(`  [payroll] run ${runId.slice(0,8)} approved — JE ${approved.journalEntryId?.slice(0,8) ?? '?'} gross R${approved.totalGross?.toFixed(2) ?? '?'} PAYE R${approved.totalPaye?.toFixed(2) ?? '?'} net R${approved.totalNet?.toFixed(2) ?? '?'}`);
    return runId;
  } catch (err) {
    errors.push({ month, module: 'payroll', message: errText(err) });
    console.error(`  [payroll] ERROR ${year}-${month}: ${errText(err)}`);
    return null;
  }
}

async function runUifPayment(month: number, year: number, errors: Err[]): Promise<void> {
  try {
    // Ensure a declaration exists for the period, submit it, then mark paid.
    const existing = await sql.query<{id:string;status:string}>(
      `SELECT id, status FROM uif_declarations
       WHERE company_id=$1 AND period_year=$2 AND period_month=$3 LIMIT 1`,
      [COMPANY_ID, year, month],
    );
    let decId: string;
    if (existing[0]) {
      decId = existing[0].id;
      if (existing[0].status === 'paid') {
        console.log(`  [uif] ${year}-${pad(month)} already paid — skip`);
        return;
      }
      if (existing[0].status === 'draft') {
        await markUifSubmitted(COMPANY_ID, decId, ADMIN_ID);
      }
    } else {
      const gen = await generateUifDeclaration(COMPANY_ID, year, month, ADMIN_ID);
      decId = gen.id;
      await markUifSubmitted(COMPANY_ID, decId, ADMIN_ID);
    }
    // Skip payment when declaration has zero totals (no payroll lines in that month)
    const dec = await sql.query<{tot:string}>(
      `SELECT (total_employee_contribution + total_employer_contribution)::text AS tot
         FROM uif_declarations WHERE id=$1 AND company_id=$2`,
      [decId, COMPANY_ID],
    );
    if (Number(dec[0]?.tot ?? 0) < 0.01) {
      console.log(`  [uif] ${year}-${pad(month)} zero-total — skip payment`);
      return;
    }
    const paid = await markUifDeclarationPaid(
      COMPANY_ID, decId,
      { paymentDate: lastDay(year, month) },
      ADMIN_ID,
    );
    console.log(`  [uif] ${year}-${pad(month)} paid R${paid.totalPaid.toFixed(2)} — JE ${paid.journalEntryId?.slice(0,8) ?? '?'}`);
  } catch (err) {
    errors.push({ month, module: 'uif', message: errText(err) });
    console.error(`  [uif] ERROR ${year}-${pad(month)}: ${errText(err)}`);
  }
}

async function runVatSubmit(month: number, year: number, errors: Err[]): Promise<void> {
  if (!VAT_MONTHS.has(month)) return;
  const periodStart = firstDay(year, month - 1);
  const periodEnd   = lastDay(year, month);
  try {
    const result = await submitVATReturn(
      COMPANY_ID,
      { periodStart, periodEnd },
      ADMIN_ID,
    );
    console.log(`  [vat-submit] ${periodStart}..${periodEnd}: output R${result.totalOutputTax.toFixed(2)} input R${result.totalInputTax.toFixed(2)} net R${result.netVat.toFixed(2)} — JE ${result.journalEntryId?.slice(0,8) ?? '?'}`);
  } catch (err) {
    const msg = errText(err);
    if (/already.*submitted|already exists/i.test(msg)) {
      console.log(`  [vat-submit] ${periodStart}..${periodEnd} already submitted — skip`);
      return;
    }
    errors.push({ month, module: 'vat-submit', message: msg });
    console.error(`  [vat-submit] ERROR ${periodStart}..${periodEnd}: ${msg}`);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('=== FY2026 Workflow Simulation (v2 — real services) ===');
  console.log(`Run date: ${new Date().toISOString().slice(0,10)}  Company: ${COMPANY_ID}`);
  console.log('='.repeat(60) + '\n');

  const jeBefore = await sql.query<{n:string}>(`SELECT COUNT(*)::text AS n FROM gl_journal_entries WHERE company_id=$1`, [COMPANY_ID]);
  const totals = { loansClosed: 0, loanPaid: 0, wipInvoices: 0, payrollRuns: 0 };
  const errors: Err[] = [];

  await linkPracticeClients();

  for (let m = 1; m <= 12; m++) {
    console.log(`--- 2026-${pad(m)} (${MONTH_NAMES[m-1]}) ---`);
    totals.loansClosed += await runLoansClose(m, 2026, errors);
    totals.loanPaid    += await runLoanPayments(m, 2026, errors);
    totals.wipInvoices += await runPracticeWip(m, 2026, errors);
    if (await runPayrollApprove(m, 2026, errors)) totals.payrollRuns++;
    await runUifPayment(m, 2026, errors);
    await runVatSubmit(m, 2026, errors);
    console.log('');
  }

  const jeAfter = await sql.query<{n:string}>(`SELECT COUNT(*)::text AS n FROM gl_journal_entries WHERE company_id=$1`, [COMPANY_ID]);
  const tb = await sql.query<{dr:string;cr:string}>(
    `SELECT COALESCE(SUM(debit),0)::text AS dr, COALESCE(SUM(credit),0)::text AS cr
     FROM gl_journal_lines WHERE company_id=$1`,
    [COMPANY_ID],
  );
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Journal entries before : ${jeBefore[0]?.n ?? '?'}`);
  console.log(`  Journal entries after  : ${jeAfter[0]?.n ?? '?'}`);
  console.log(`  TB debits   : R${Number(tb[0]?.dr ?? 0).toFixed(2)}`);
  console.log(`  TB credits  : R${Number(tb[0]?.cr ?? 0).toFixed(2)}`);
  console.log(`  TB diff     : R${(Number(tb[0]?.dr ?? 0) - Number(tb[0]?.cr ?? 0)).toFixed(2)} ${Math.abs(Number(tb[0]?.dr ?? 0) - Number(tb[0]?.cr ?? 0)) < 0.01 ? 'balanced' : 'UNBALANCED'}`);
  console.log(`  Loans reclass        : ${totals.loansClosed}`);
  console.log(`  Loan payments        : ${totals.loanPaid}`);
  console.log(`  WIP invoices         : ${totals.wipInvoices}`);
  console.log(`  Payroll runs approved: ${totals.payrollRuns}`);
  console.log(`  Errors               : ${errors.length}`);
  for (const e of errors.slice(0, 20)) console.log(`    [${e.module}] month=${e.month}: ${e.message}`);
  console.log('='.repeat(60));

  await closeSql();
  await closeLoansPool();
  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch(err => { console.error('[FATAL]', errText(err)); Promise.all([closeSql(), closeLoansPool()]).finally(() => process.exit(2)); });
