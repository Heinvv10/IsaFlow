/**
 * ISAFlow Loans Demo Data Seeder (PRD-03)
 *
 * Populates the Demo company with 3 realistic South African loans, complete
 * amortisation schedules, loan events, and GL postings.
 *
 * Run with:
 *   export $(grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' .env.local | xargs)
 *   bunx tsx scripts/seed-loans-data.ts
 *
 * Uses MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS) so RLS won't block inserts.
 * Never concatenates values into SQL — all values go through parameterised queries.
 */

import { createSql, closeSql } from './_pg';
import { amortise } from '../src/lib/amortisation/engine';
import type { LoanInputs, ScheduleRow } from '../src/lib/amortisation/types';

// ── Connection ────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not set');
  process.exit(1);
}

const sql = createSql(DATABASE_URL);

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';

// Deterministic loan IDs
const LOAN_IDS = {
  bond:            'a1100000-0000-0000-0000-000000000001',
  vehicle:         'a1100000-0000-0000-0000-000000000002',
  shareholder:     'a1100000-0000-0000-0000-000000000003',
} as const;

// Deterministic schedule-run IDs (one run per loan)
const RUN_IDS = {
  bond:        'a1b00000-0000-0000-0000-000000000001',
  vehicle:     'a1b00000-0000-0000-0000-000000000002',
  shareholder: 'a1b00000-0000-0000-0000-000000000003',
} as const;

// Deterministic GL posting IDs — 3 postings per loan (drawdown debit, drawdown credit, interest)
const GL_IDS = {
  bond:        ['a1a00000-0000-0000-0000-000000000001', 'a1a00000-0000-0000-0000-000000000002', 'a1a00000-0000-0000-0000-000000000003'],
  vehicle:     ['a1a00000-0000-0000-0000-000000000004', 'a1a00000-0000-0000-0000-000000000005', 'a1a00000-0000-0000-0000-000000000006'],
  shareholder: ['a1a00000-0000-0000-0000-000000000007', 'a1a00000-0000-0000-0000-000000000008', 'a1a00000-0000-0000-0000-000000000009'],
} as const;

// Engine version must match loanScheduleService.ts
const ENGINE_VERSION = '1.0.0';

// ── Loan definitions ──────────────────────────────────────────────────────────

interface LoanDef {
  id: string;
  runId: string;
  glIds: readonly string[];
  reference: string;
  product: string;
  description: string;
  inputs: LoanInputs;
}

const LOAN_DEFS: LoanDef[] = [
  {
    id: LOAN_IDS.bond,
    runId: RUN_IDS.bond,
    glIds: GL_IDS.bond,
    reference: 'BOND-2024-001',
    product: 'bond',
    description: 'Property bond — ISAFlow Demo Office, 15 Sandton Drive, Johannesburg',
    inputs: {
      id: LOAN_IDS.bond,
      principal: 2_800_000,
      startDate: '2024-01-01',
      termMonths: 240,              // 20 years
      rateMode: 'FIXED',
      margin: 0,
      fixedRate: 11.5,
      residual: 0,
      recurringSkipMonths: [],
      dayCount: '30_360',
      repriceMode: 'FIXED_INSTALLMENT',
      skipMode: 'MAINTAIN_TERM',
      lumpMode: 'REDUCE_INSTALLMENT',
    },
  },
  {
    id: LOAN_IDS.vehicle,
    runId: RUN_IDS.vehicle,
    glIds: GL_IDS.vehicle,
    reference: 'VEH-2025-001',
    product: 'vehicle',
    description: 'Vehicle finance — Mercedes-Benz Sprinter panel van (fleet)',
    inputs: {
      id: LOAN_IDS.vehicle,
      principal: 450_000,
      startDate: '2025-06-01',
      termMonths: 60,               // 5 years
      rateMode: 'FIXED',
      margin: 0,
      fixedRate: 13.75,
      residual: 0,
      recurringSkipMonths: [],
      dayCount: 'ACTUAL_365',
      repriceMode: 'FIXED_INSTALLMENT',
      skipMode: 'MAINTAIN_TERM',
      lumpMode: 'REDUCE_INSTALLMENT',
    },
  },
  {
    id: LOAN_IDS.shareholder,
    runId: RUN_IDS.shareholder,
    glIds: GL_IDS.shareholder,
    reference: 'SHL-2023-001',
    product: 'shareholder_loan',
    description: 'Shareholder loan — J. van der Merwe, interest-only with capital bullet at term',
    inputs: {
      id: LOAN_IDS.shareholder,
      principal: 1_500_000,
      startDate: '2023-04-01',
      termMonths: 120,              // 10 years
      rateMode: 'FIXED',
      margin: 0,
      fixedRate: 8.0,
      residual: 1_499_000,         // Near-zero amortisation = simple interest simulation
      recurringSkipMonths: [],
      dayCount: 'ACTUAL_365',
      repriceMode: 'FIXED_INSTALLMENT',
      skipMode: 'MAINTAIN_TERM',
      lumpMode: 'REDUCE_INSTALLMENT',
    },
  },
];

// ── GL account resolver ───────────────────────────────────────────────────────

interface GlAccounts {
  liability: string;       // 2210 Long-term Loans
  bank: string;            // 1110 Bank - Primary
  interestExpense: string; // 5700 Bank Charges (closest expense account; real impl would use a dedicated interest expense account)
  interestPayable: string; // 2130 Accrued Expenses
  currentPortion: string;  // 2110 Accounts Payable (proxy for current portion of LTD)
}

async function resolveGlAccounts(): Promise<GlAccounts | null> {
  const codes = ['2210', '1110', '5700', '2130', '2110'];
  const rows = await sql.query<{ account_code: string; id: string }>(
    `SELECT account_code, id FROM gl_accounts WHERE company_id = $1 AND account_code = ANY($2)`,
    [COMPANY_ID, codes],
  );
  const map: Record<string, string> = {};
  for (const r of rows) map[r.account_code] = r.id;

  if (!map['2210'] || !map['1110'] || !map['5700'] || !map['2130'] || !map['2110']) {
    console.warn('  [WARN] Some GL accounts not found — GL postings will be skipped');
    console.warn('  Found codes:', Object.keys(map).join(', '));
    return null;
  }

  return {
    liability:       map['2210']!,
    bank:            map['1110']!,
    interestExpense: map['5700']!,
    interestPayable: map['2130']!,
    currentPortion:  map['2110']!,
  };
}

// ── Clean existing data ───────────────────────────────────────────────────────

async function cleanExisting(): Promise<void> {
  console.log('[CLEAN] Deleting existing loan seed rows for demo company…');
  const loanIds = Object.values(LOAN_IDS);

  // Delete in FK order: rows → runs → GL postings → compliance → events → loans
  await sql.query(
    `DELETE FROM loan_schedule_rows
     WHERE run_id IN (SELECT id FROM loan_schedule_runs WHERE loan_id = ANY($1))`,
    [loanIds],
  );
  console.log('  loan_schedule_rows deleted');

  await sql.query(
    `DELETE FROM loan_schedule_runs WHERE loan_id = ANY($1)`,
    [loanIds],
  );
  console.log('  loan_schedule_runs deleted');

  await sql.query(
    `DELETE FROM loan_gl_postings WHERE loan_id = ANY($1) AND company_id = $2`,
    [loanIds, COMPANY_ID],
  );
  console.log('  loan_gl_postings deleted');

  // loan_compliance_assessments may not exist — skip gracefully
  try {
    await sql.query(
      `DELETE FROM loan_compliance_assessments WHERE loan_id = ANY($1) AND company_id = $2`,
      [loanIds, COMPANY_ID],
    );
    console.log('  loan_compliance_assessments deleted');
  } catch {
    console.log('  loan_compliance_assessments — table not found, skipping');
  }

  await sql.query(
    `DELETE FROM loan_events WHERE loan_id = ANY($1) AND company_id = $2`,
    [loanIds, COMPANY_ID],
  );
  console.log('  loan_events deleted');

  await sql.query(
    `DELETE FROM loans WHERE id = ANY($1) AND company_id = $2`,
    [loanIds, COMPANY_ID],
  );
  console.log('  loans deleted');

  console.log('[CLEAN] Done.\n');
}

// ── Insert loans ──────────────────────────────────────────────────────────────

async function insertLoans(): Promise<void> {
  console.log('[LOANS] Inserting 3 loan master rows…');

  for (const def of LOAN_DEFS) {
    const { inputs } = def;
    await sql.query(
      `INSERT INTO loans (
         id, company_id, reference, product, description,
         principal, start_date, term_months,
         rate_mode, margin, fixed_rate, residual,
         day_count, reprice_mode, skip_mode, lump_mode,
         recurring_skip_months, status, nca_compliant, currency,
         origination_fee, origination_fee_vat_type
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20,
         $21, $22
       )`,
      [
        def.id, COMPANY_ID, def.reference, def.product, def.description,
        inputs.principal, inputs.startDate, inputs.termMonths,
        inputs.rateMode, inputs.margin, inputs.fixedRate ?? null, inputs.residual,
        inputs.dayCount, inputs.repriceMode, inputs.skipMode, inputs.lumpMode,
        inputs.recurringSkipMonths ?? [], 'active', true, 'ZAR',
        0, 'exempt',
      ],
    );
    console.log(`  Inserted ${def.reference} (${def.product})`);
  }

  console.log('[LOANS] Done.\n');
}

// ── Compute and insert schedules ──────────────────────────────────────────────

async function insertSchedules(): Promise<Map<string, number>> {
  console.log('[SCHEDULES] Computing amortisation schedules via engine…');
  const counts = new Map<string, number>();

  for (const def of LOAN_DEFS) {
    // FIXED-rate loans need no rate curve
    const scheduleRows: ScheduleRow[] = amortise(def.inputs, [], []);
    const periodCount = scheduleRows.length;

    // Insert run
    await sql.query(
      `INSERT INTO loan_schedule_runs (id, loan_id, company_id, engine_version, inputs_hash, computed_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [def.runId, def.id, COMPANY_ID, ENGINE_VERSION, `seed-${def.id.slice(0, 8)}`],
    );

    // Insert rows in batches of 50
    const BATCH = 50;
    for (let i = 0; i < scheduleRows.length; i += BATCH) {
      const chunk = scheduleRows.slice(i, i + BATCH);
      const valuePlaceholders = chunk.map((_, ri) => {
        const base = ri * 15;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15})`;
      }).join(',');

      const values = chunk.flatMap(r => [
        def.runId, r.period, r.date,
        r.opening, r.rate, r.installment, r.interest, r.principal,
        r.lump, r.skip, r.payment, r.closing, r.stLiability,
        r.extrapolated, r.nca_flagged,
      ]);

      await sql.query(
        `INSERT INTO loan_schedule_rows
           (run_id, period, date, opening, rate, installment, interest, principal,
            lump, skip_flag, payment, closing, st_liability, extrapolated, nca_flagged)
         VALUES ${valuePlaceholders}`,
        values,
      );
    }

    counts.set(def.reference, periodCount);
    console.log(`  ${def.reference}: ${periodCount} schedule rows`);
  }

  console.log('[SCHEDULES] Done.\n');
  return counts;
}

// ── Insert loan events ────────────────────────────────────────────────────────
// loan_events.kind is CHECK IN ('LUMP','SKIP','RESTRUCTURE','WRITEOFF').
// We seed realistic LUMP payments (ad-hoc capital injections) for each loan.

async function insertEvents(): Promise<void> {
  console.log('[EVENTS] Inserting loan events…');

  type EventRow = {
    loan_id: string;
    event_date: string;
    kind: string;
    amount: number | null;
    note: string;
  };

  const events: EventRow[] = [
    // Bond — one early lump-sum capital reduction
    {
      loan_id: LOAN_IDS.bond,
      event_date: '2024-07-01',
      kind: 'LUMP',
      amount: 50_000,
      note: 'Windfall income applied to reduce bond principal',
    },
    {
      loan_id: LOAN_IDS.bond,
      event_date: '2025-01-01',
      kind: 'LUMP',
      amount: 100_000,
      note: 'FY2025 bonus proceeds applied to bond',
    },
    {
      loan_id: LOAN_IDS.bond,
      event_date: '2025-06-01',
      kind: 'RESTRUCTURE',
      amount: null,
      note: 'Annual covenant review — no material change',
    },
    // Vehicle — one lump payment mid-term
    {
      loan_id: LOAN_IDS.vehicle,
      event_date: '2025-12-01',
      kind: 'LUMP',
      amount: 20_000,
      note: 'Partial early settlement from insurance refund',
    },
    {
      loan_id: LOAN_IDS.vehicle,
      event_date: '2026-03-01',
      kind: 'RESTRUCTURE',
      amount: null,
      note: 'Rate lock confirmed — no repricing required',
    },
    // Shareholder loan — restructure note + one LUMP top-up (negative: shareholder injects more)
    {
      loan_id: LOAN_IDS.shareholder,
      event_date: '2024-04-01',
      kind: 'RESTRUCTURE',
      amount: null,
      note: 'Annual interest confirmation per s45 SARS ruling',
    },
    {
      loan_id: LOAN_IDS.shareholder,
      event_date: '2025-04-01',
      kind: 'RESTRUCTURE',
      amount: null,
      note: 'Shareholder waived interest for FY2025 (loan terms unchanged)',
    },
    {
      loan_id: LOAN_IDS.shareholder,
      event_date: '2026-01-01',
      kind: 'LUMP',
      amount: 200_000,
      note: 'Partial capital repayment by company',
    },
  ];

  for (const ev of events) {
    await sql.query(
      `INSERT INTO loan_events (loan_id, company_id, event_date, kind, amount, note, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ev.loan_id, COMPANY_ID, ev.event_date, ev.kind, ev.amount, ev.note, ADMIN_ID],
    );
  }

  console.log(`  Inserted ${events.length} events across 3 loans`);
  console.log('[EVENTS] Done.\n');
}

// ── Insert GL postings ────────────────────────────────────────────────────────
// 3 postings per loan:
//  1. Drawdown — debit Bank, credit Long-term Loans (period 0 = drawdown)
//  2. First month interest — debit Interest Expense, credit Accrued Expenses
//  3. Second month interest — repeat pattern

async function insertGlPostings(gl: GlAccounts): Promise<void> {
  console.log('[GL POSTINGS] Inserting GL postings for drawdown and first payments…');

  type PostingDef = {
    id: string;
    loanId: string;
    period: number;
    postingDate: string;
    accountId: string;
    debit: number;
    credit: number;
    narrative: string;
    postedPeriod: string;
  };

  const postings: PostingDef[] = [
    // ── Bond drawdown (Jan 2024) ──
    {
      id: GL_IDS.bond[0]!,
      loanId: LOAN_IDS.bond,
      period: 0,
      postingDate: '2024-01-01',
      accountId: gl.bank,
      debit: 2_800_000,
      credit: 0,
      narrative: 'Bond drawdown — 15 Sandton Drive',
      postedPeriod: '202401',
    },
    {
      id: GL_IDS.bond[1]!,
      loanId: LOAN_IDS.bond,
      period: 0,
      postingDate: '2024-01-01',
      accountId: gl.liability,
      debit: 0,
      credit: 2_800_000,
      narrative: 'Bond drawdown — 15 Sandton Drive (liability)',
      postedPeriod: '202401',
    },
    {
      id: GL_IDS.bond[2]!,
      loanId: LOAN_IDS.bond,
      period: 1,
      postingDate: '2024-02-01',
      accountId: gl.interestExpense,
      debit: 26_833.33,  // ~2 800 000 × 11.5% / 12
      credit: 0,
      narrative: 'Bond interest — Feb 2024',
      postedPeriod: '202402',
    },

    // ── Vehicle drawdown (Jun 2025) ──
    {
      id: GL_IDS.vehicle[0]!,
      loanId: LOAN_IDS.vehicle,
      period: 0,
      postingDate: '2025-06-01',
      accountId: gl.bank,
      debit: 450_000,
      credit: 0,
      narrative: 'Vehicle finance drawdown — Mercedes-Benz Sprinter',
      postedPeriod: '202506',
    },
    {
      id: GL_IDS.vehicle[1]!,
      loanId: LOAN_IDS.vehicle,
      period: 0,
      postingDate: '2025-06-01',
      accountId: gl.liability,
      debit: 0,
      credit: 450_000,
      narrative: 'Vehicle finance drawdown — liability recognition',
      postedPeriod: '202506',
    },
    {
      id: GL_IDS.vehicle[2]!,
      loanId: LOAN_IDS.vehicle,
      period: 1,
      postingDate: '2025-07-01',
      accountId: gl.interestExpense,
      debit: 5_156.25,   // ~450 000 × 13.75% / 12
      credit: 0,
      narrative: 'Vehicle finance interest — Jul 2025',
      postedPeriod: '202507',
    },

    // ── Shareholder loan drawdown (Apr 2023) ──
    {
      id: GL_IDS.shareholder[0]!,
      loanId: LOAN_IDS.shareholder,
      period: 0,
      postingDate: '2023-04-01',
      accountId: gl.bank,
      debit: 1_500_000,
      credit: 0,
      narrative: 'Shareholder loan receipt — J. van der Merwe',
      postedPeriod: '202304',
    },
    {
      id: GL_IDS.shareholder[1]!,
      loanId: LOAN_IDS.shareholder,
      period: 0,
      postingDate: '2023-04-01',
      accountId: gl.liability,
      debit: 0,
      credit: 1_500_000,
      narrative: 'Shareholder loan — liability recognition',
      postedPeriod: '202304',
    },
    {
      id: GL_IDS.shareholder[2]!,
      loanId: LOAN_IDS.shareholder,
      period: 1,
      postingDate: '2023-05-01',
      accountId: gl.interestExpense,
      debit: 10_000,     // 1 500 000 × 8% / 12
      credit: 0,
      narrative: 'Shareholder loan interest — May 2023',
      postedPeriod: '202305',
    },
  ];

  for (const p of postings) {
    await sql.query(
      `INSERT INTO loan_gl_postings
         (id, company_id, loan_id, period, posting_date, account_id,
          debit, credit, narrative, posted_period)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        p.id, COMPANY_ID, p.loanId, p.period, p.postingDate, p.accountId,
        p.debit, p.credit, p.narrative, p.postedPeriod,
      ],
    );
  }

  console.log(`  Inserted ${postings.length} GL postings`);
  console.log('[GL POSTINGS] Done.\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('ISAFlow Loans Seed — PRD-03 Demo Data');
  console.log(`Company: ${COMPANY_ID}`);
  console.log('='.repeat(60));
  console.log();

  await cleanExisting();
  await insertLoans();
  const counts = await insertSchedules();
  await insertEvents();

  const glAccounts = await resolveGlAccounts();
  if (glAccounts) {
    await insertGlPostings(glAccounts);
  } else {
    console.log('[GL POSTINGS] Skipped — GL accounts not found.\n');
  }

  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const def of LOAN_DEFS) {
    const n = counts.get(def.reference) ?? 0;
    console.log(`  ${def.reference.padEnd(20)} ${n} schedule rows  (${def.inputs.termMonths} months)`);
  }
  console.log();
  console.log('Seed complete. Run /accounting/loans to verify portfolio KPIs.');
  console.log('='.repeat(60));

  await closeSql();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
