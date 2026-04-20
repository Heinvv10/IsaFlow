/**
 * simulate-fy2026-workflows.ts — FY2026 End-to-End Workflow Simulator
 *
 * Drives real DB operations for the demo company through Jan–Dec 2026:
 *   1. Loans period close (reclassification journals, no period lock)
 *   2. Practice WIP → customer invoice (per-client, month-scoped)
 *   3. Payroll run approve (create+approve if not present)
 *   4. VAT return read (bi-monthly: Feb, Apr, Jun, Aug, Oct, Dec)
 *
 * Run:
 *   export $(grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' .env.local | xargs)
 *   bunx tsx scripts/simulate-fy2026-workflows.ts
 */

import { createSql, closeSql } from './_pg';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not set'); process.exit(1); }
const sql = createSql(DATABASE_URL);

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const VAT_MONTHS  = new Set([2, 4, 6, 8, 10, 12]);

type Row = Record<string, unknown>;
interface Err { month: number; module: string; message: string; }

const r2 = (n: number) => Math.round(n * 100) / 100;
const fR  = (n: number) => `R${n.toFixed(2)}`;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(y, m, 0).toISOString().slice(0, 10);
const yyyymm  = (y: number, m: number) => `${y}${pad(m)}`;

async function findFiscalPeriod(date: string): Promise<string | null> {
  const rows = await sql.query<{id:string}>(
    `SELECT id FROM fiscal_periods WHERE company_id=$1 AND start_date<=$2::DATE AND end_date>=$2::DATE LIMIT 1`,
    [COMPANY_ID, date],
  );
  return rows[0]?.id ?? null;
}

async function createAndPostJE(date: string, desc: string, source: string,
  lines: {acct:string; dr:number; cr:number}[]
): Promise<string> {
  const fpId = await findFiscalPeriod(date);
  const id = randomUUID();
  await sql.query(
    `INSERT INTO gl_journal_entries (id,company_id,entry_date,fiscal_period_id,description,source,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, COMPANY_ID, date, fpId, desc, source, ADMIN_ID],
  );
  for (const l of lines) {
    await sql.query(
      `INSERT INTO gl_journal_lines (journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, l.acct, l.dr, l.cr, desc, COMPANY_ID],
    );
  }
  await sql.query(
    `UPDATE gl_journal_entries SET status='posted',posted_at=NOW(),posted_by=$1 WHERE id=$2 AND company_id=$3`,
    [ADMIN_ID, id, COMPANY_ID],
  );
  return id;
}

// ── PREREQ: link practice clients ────────────────────────────────────────────

async function linkPracticeClients(): Promise<void> {
  const clients = await sql.query<{id:string;legal_name:string;link_customer_id:string|null;registration_no:string|null;tax_no:string|null}>(
    `SELECT id,legal_name,link_customer_id,registration_no,tax_no FROM practice_clients WHERE company_id=$1 AND status='active'`,
    [COMPANY_ID],
  );
  let linked = 0;
  for (const c of clients) {
    if (c.link_customer_id) continue;
    const cid = randomUUID();
    await sql.query(
      `INSERT INTO customers (id,company_id,name,registration_number,vat_number,is_active,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,true,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [cid, COMPANY_ID, c.legal_name, c.registration_no, c.tax_no],
    );
    await sql.query(`UPDATE practice_clients SET link_customer_id=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3`,
      [cid, c.id, COMPANY_ID]);
    linked++;
  }
  console.log(`[PREREQ] ${linked} practice client→customer links created (${clients.length - linked} already set)\n`);
}

// ── MODULE 1: Loans close ────────────────────────────────────────────────────

async function runLoansClose(month: number, year: number, errors: Err[]): Promise<number> {
  const period = yyyymm(year, month);
  try {
    const locked = await sql.query(`SELECT yyyymm FROM loan_period_locks WHERE company_id=$1 AND yyyymm=$2`, [COMPANY_ID, period]);
    if (locked.length > 0) { console.log(`  [loans] ${period} already locked — skip`); return 0; }

    const rows = await sql.query<Row>(
      `SELECT l.*,snap.closing AS sc,snap.st_liability AS ssl,snap.date AS sd
       FROM loans l
       LEFT JOIN LATERAL (
         SELECT lsr.closing,lsr.st_liability,lsr.date FROM loan_schedule_rows lsr
         JOIN loan_schedule_runs lsrun ON lsrun.id=lsr.run_id
         WHERE lsrun.loan_id=l.id AND TO_CHAR(lsr.date,'YYYYMM')=$1
         ORDER BY lsrun.computed_at DESC NULLS LAST, lsr.period DESC LIMIT 1
       ) snap ON true
       WHERE l.company_id=$2 AND l.status='active'`,
      [period, COMPANY_ID],
    );

    let done = 0;
    for (const row of rows) {
      if ([row['gl_account_id'],row['current_portion_account_id']].some(v=>v==null)) continue;
      if (row['sc'] == null || row['sd'] == null) continue;
      const stL = parseFloat(String(row['ssl'] ?? '0'));
      if (stL <= 0) continue;
      const rawDate = row['sd'];
      const date = rawDate instanceof Date
        ? rawDate.toISOString().slice(0, 10)
        : String(rawDate).slice(0, 10);
      const note = `Reclassification – loan ${String(row['reference'] ?? row['id'])} for ${period}`;
      await createAndPostJE(date, note, 'manual', [
        { acct: String(row['gl_account_id']),        dr: stL, cr: 0   },
        { acct: String(row['current_portion_account_id']), dr: 0,   cr: stL },
      ]);
      done++;
    }
    console.log(`  [loans] ${period}: ${done} reclass journals, ${rows.length - done} skipped`);
    return done;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ month, module: 'loans', message: msg });
    console.error(`  [loans] ERROR ${period}: ${msg}`);
    return 0;
  }
}

// ── MODULE 2: Practice WIP → invoice ────────────────────────────────────────

async function runPracticeWip(month: number, year: number, errors: Err[]): Promise<number> {
  const pStart = `${year}-${pad(month)}-01`;
  const pEnd   = lastDay(year, month);
  let created  = 0;
  try {
    const clients = await sql.query<{id:string;legal_name:string;link_customer_id:string}>(
      `SELECT id,legal_name,link_customer_id FROM practice_clients WHERE company_id=$1 AND status='active' AND link_customer_id IS NOT NULL`,
      [COMPANY_ID],
    );
    for (const c of clients) {
      try {
        const entries = await sql.query<{id:string;line_total:string}>(
          `SELECT id,line_total FROM time_entries WHERE company_id=$1 AND practice_client_id=$2
           AND status='approved' AND billed_at IS NULL AND billable=true AND line_total IS NOT NULL
           AND entry_date>=$3::DATE AND entry_date<=$4::DATE`,
          [COMPANY_ID, c.id, pStart, pEnd],
        );
        if (!entries.length) continue;

        const subtotal = r2(entries.reduce((s,e)=>s+Number(e.line_total),0));
        const tax      = r2(subtotal * 0.15);
        const total    = r2(subtotal + tax);

        // Collision-safe invoice number
        let invId = '', invNum = '';
        for (let a = 0; a < 5; a++) {
          const mx = await sql.query<{max_num:string}>(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)),0) AS max_num
             FROM customer_invoices WHERE company_id=$1 AND invoice_number~'^INV-[0-9]+$'`,
            [COMPANY_ID],
          );
          invNum = `INV-${String(Number(mx[0]?.max_num??0)+1+a).padStart(5,'0')}`;
          try {
            const ir = await sql.query<{id:string}>(
              `INSERT INTO customer_invoices (company_id,invoice_number,customer_id,client_id,subtotal,tax_rate,tax_amount,total_amount,invoice_date,status,created_by,currency_code,exchange_rate,functional_total)
               VALUES ($1,$2,$3,$3,$4,15,$5,$6,$7,'draft',$8,'ZAR',1.0,$6) RETURNING id`,
              [COMPANY_ID,invNum,c.link_customer_id,subtotal,tax,total,pEnd,ADMIN_ID],
            );
            invId = String(ir[0]!.id); break;
          } catch (ce) {
            if (ce instanceof Error && ce.message.includes('unique') && a<4) continue;
            throw ce;
          }
        }
        if (!invId) throw new Error('invoice number exhausted 5 attempts');

        for (const e of entries) {
          await sql.query(
            `INSERT INTO customer_invoice_items (invoice_id,description,unit_price,quantity,amount,tax_rate,currency_code,time_entry_id)
             VALUES ($1,$2,0,1,$3,15,'ZAR',$4)`,
            [invId,`Time entry — ${pEnd}`,Number(e.line_total),e.id],
          );
        }
        await sql.query(
          `UPDATE time_entries SET billed_at=NOW(),invoice_id=$1,updated_at=NOW() WHERE id=ANY($2::UUID[]) AND company_id=$3`,
          [invId, entries.map(e=>e.id), COMPANY_ID],
        );
        console.log(`  [practice-wip] ${c.legal_name}: ${fR(subtotal)} + ${fR(tax)} VAT = ${fR(total)} → ${invNum}`);
        created++;
      } catch (ce) {
        const msg = ce instanceof Error ? ce.message : String(ce);
        errors.push({ month, module:'practice-wip', message:`${c.legal_name}: ${msg}` });
        console.error(`  [practice-wip] ERROR ${c.legal_name}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ month, module:'practice-wip', message: msg });
    console.error(`  [practice-wip] ERROR: ${msg}`);
  }
  if (!created) console.log(`  [practice-wip] no billable entries for ${year}-${pad(month)} — skip`);
  return created;
}

// ── MODULE 3: Payroll approve ────────────────────────────────────────────────

async function runPayrollApprove(month: number, year: number, gl: Record<string,string>, errors: Err[]): Promise<boolean> {
  try {
    let runs = await sql.query<{id:string;status:string;journal_entry_id:string|null;total_gross:string;total_net:string;total_paye:string}>(
      `SELECT id,status,journal_entry_id,total_gross,total_net,total_paye FROM payroll_run_headers WHERE company_id=$1 AND period_year=$2 AND period_month=$3`,
      [COMPANY_ID, year, month],
    );
    if (!runs.length) {
      await sql.query(
        `INSERT INTO payroll_run_headers (company_id,period_month,period_year,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [COMPANY_ID, month, year, ADMIN_ID],
      );
      runs = await sql.query(`SELECT id,status,journal_entry_id,total_gross,total_net,total_paye FROM payroll_run_headers WHERE company_id=$1 AND period_year=$2 AND period_month=$3`,
        [COMPANY_ID, year, month]);
    }
    const run = runs[0]; if (!run) { console.log(`  [payroll] no run for ${year}-${month}`); return false; }
    if (run.journal_entry_id) { console.log(`  [payroll] run ${run.id} already approved — skip`); return false; }

    if (run.status === 'draft') {
      const ec = await sql.query<{cnt:string}>(`SELECT COUNT(*) AS cnt FROM payroll_employees WHERE company_id=$1 AND status='active'`,[COMPANY_ID]);
      const n = Number(ec[0]?.cnt??0), gross = n*25000, paye = r2(gross*0.25), net = r2(gross-paye);
      await sql.query(
        `UPDATE payroll_run_headers SET status='calculated',total_gross=$1,total_taxable=$1,total_paye=$2,total_net=$3,employee_count=$4,updated_at=NOW() WHERE id=$5 AND company_id=$6`,
        [gross, paye, net, n, run.id, COMPANY_ID],
      );
      runs = await sql.query(`SELECT id,status,journal_entry_id,total_gross,total_net,total_paye FROM payroll_run_headers WHERE id=$1`,[run.id]);
    }

    const r = runs[0]!;
    const gross = Number(r.total_gross), paye = Number(r.total_paye), net = Number(r.total_net);
    const date  = `${year}-${pad(month)}-28`;
    const note  = `Payroll ${year}-${pad(month)} approved`;
    const lines = [];
    if (gl['5200'] && gl['1110']) {
      lines.push({ acct: gl['5200']!, dr: gross, cr: 0 });
      if (gl['2140'] && paye > 0) lines.push({ acct: gl['2140']!, dr: 0, cr: paye });
      lines.push({ acct: gl['1110']!, dr: 0, cr: net });
    }
    const jeId = await createAndPostJE(date, note, 'auto_payroll', lines);
    await sql.query(`UPDATE payroll_run_headers SET status='approved',updated_at=NOW() WHERE id=$1 AND company_id=$2`,[r.id,COMPANY_ID]);
    try { await sql.query(`UPDATE payroll_run_headers SET journal_entry_id=$1 WHERE id=$2 AND company_id=$3`,[jeId,r.id,COMPANY_ID]); } catch { /* mig 399 not applied */ }
    console.log(`  [payroll] run ${r.id} approved — JE ${jeId} gross=${fR(gross)} PAYE=${fR(paye)} net=${fR(net)}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ month, module:'payroll', message: msg });
    console.error(`  [payroll] ERROR ${year}-${month}: ${msg}`);
    return false;
  }
}

// ── MODULE 4: VAT return (read-only) ────────────────────────────────────────

async function runVat(month: number, year: number, errors: Err[]): Promise<void> {
  const pStart = `${year}-${pad(month-1)}-01`;
  const pEnd   = lastDay(year, month);
  try {
    const [out, inp] = await Promise.all([
      sql.query<{total:string}>(
        `SELECT COALESCE(SUM(jl.credit-jl.debit),0) AS total FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
         JOIN gl_accounts ga ON ga.id=jl.gl_account_id
         WHERE je.company_id=$1 AND jl.company_id=$1 AND je.status='posted'
           AND je.entry_date>=$2::DATE AND je.entry_date<=$3::DATE
           AND ga.account_subtype='vat_output'`,
        [COMPANY_ID, pStart, pEnd],
      ),
      sql.query<{total:string}>(
        `SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS total FROM gl_journal_lines jl
         JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
         JOIN gl_accounts ga ON ga.id=jl.gl_account_id
         WHERE je.company_id=$1 AND jl.company_id=$1 AND je.status='posted'
           AND je.entry_date>=$2::DATE AND je.entry_date<=$3::DATE
           AND ga.account_subtype='vat_input'`,
        [COMPANY_ID, pStart, pEnd],
      ),
    ]);
    const o = r2(Number(out[0]?.total??0)), i = r2(Number(inp[0]?.total??0));
    console.log(`  [vat] period ${pStart}..${pEnd}: output ${fR(o)} input ${fR(i)} net ${fR(r2(o-i))}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ month, module:'vat', message: msg });
    console.error(`  [vat] ERROR: ${msg}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('=== FY2026 Workflow Simulation ===');
  console.log(`Run date: ${new Date().toISOString().slice(0,10)}  Company: ${COMPANY_ID}`);
  console.log('='.repeat(60));
  console.log();

  const errors: Err[] = [];
  let invoices = 0, loanReclass = 0, payrollApproved = 0;

  await linkPracticeClients();

  const jeBefore = await sql.query<{cnt:string}>(`SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE company_id=$1`,[COMPANY_ID]);

  const glRows = await sql.query<{account_code:string;id:string}>(
    `SELECT account_code,id FROM gl_accounts WHERE company_id=$1 AND account_code=ANY($2)`,
    [COMPANY_ID, ['5200','2130','2140','1110']],
  );
  const gl: Record<string,string> = {};
  for (const r of glRows) gl[r.account_code] = r.id;

  for (let month = 1; month <= 12; month++) {
    const name = MONTH_NAMES[month-1]!;
    console.log(`--- 2026-${pad(month)} (${name}) ---`);
    loanReclass   += await runLoansClose(month, 2026, errors);
    invoices      += await runPracticeWip(month, 2026, errors);
    if (await runPayrollApprove(month, 2026, gl, errors)) payrollApproved++;
    if (VAT_MONTHS.has(month)) await runVat(month, 2026, errors);
    console.log();
  }

  const jeAfter = await sql.query<{cnt:string}>(`SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE company_id=$1`,[COMPANY_ID]);
  const tb = await sql.query<{d:string;c:string}>(
    `SELECT COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c
     FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.company_id=$1 AND je.status='posted'`,
    [COMPANY_ID],
  );
  const tbDiff = r2(Math.abs(Number(tb[0]?.d??0) - Number(tb[0]?.c??0)));
  const before = Number(jeBefore[0]?.cnt??0), after = Number(jeAfter[0]?.cnt??0);

  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Journal entries before : ${before}`);
  console.log(`  Journal entries after  : ${after} (+${after-before})`);
  console.log(`  Trial balance diff     : ${fR(tbDiff)} ${tbDiff===0?'balanced':'UNBALANCED'}`);
  console.log(`  Customer invoices      : ${invoices}`);
  console.log(`  Loan reclass journals  : ${loanReclass}`);
  console.log(`  Payroll runs approved  : ${payrollApproved}`);
  console.log(`  Errors                 : ${errors.length}`);
  if (errors.length) {
    for (const e of errors) console.log(`    [${e.module}] month=${e.month}: ${e.message}`);
  }
  console.log('='.repeat(60));

  await closeSql();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('[FATAL]', err instanceof Error ? err.message : err);
  void closeSql();
  process.exit(1);
});
