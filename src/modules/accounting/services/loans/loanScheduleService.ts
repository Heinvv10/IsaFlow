import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanEvent, ScheduleRow } from '@/lib/amortisation/types';
import {
  ENGINE_VERSION,
  buildInputsHash,
  dbEventToEngine,
  dbPointToEngine,
  loanRowToInputs,
  mapDbRowToSchedule,
} from './loanScheduleInputs';

type Row = DbRow;

export interface ScheduleResult {
  rows: ScheduleRow[];
  runId: string | null;
  cached: boolean;
  computedAt: string;
}

export interface PortfolioSummary {
  totalLoans: number;
  /** Actual outstanding = original principal − sum of recorded principal payments */
  totalOutstanding: number;
  /** Forward-looking outstanding from the latest amortisation schedule projection */
  totalOutstandingProjected: number;
  weightedAvgRate: number;
  next12mInterest: number;
  totalCurrentPortion: number;
  activeCount: number;
  closedCount: number;
}

/**
 * `forShare` pins the terms for the caller's transaction. Without it a concurrent
 * updateLoan can land between this read and the cache-hit computed_at touch, and
 * the touch then promotes a run built on the superseded terms over the run the
 * edit produced — the same defect the touch exists to prevent, with the operands
 * swapped. Only getOrComputeSchedule needs it; previewSchedule writes nothing and
 * must not block edits. The caller must be inside a transaction (withAuth opens
 * one) or the lock is released at statement end and the window reopens.
 */
async function fetchLoanData(companyId: string, loanId: string, forShare = false) {
  const loans = (await (forShare
    ? sql`SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId} FOR SHARE`
    : sql`SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId}`)) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);
  return loans[0]!;
}

async function fetchEvents(companyId: string, loanId: string): Promise<Row[]> {
  return (await sql`
    SELECT * FROM loan_events
    WHERE loan_id = ${loanId} AND company_id = ${companyId}
    ORDER BY event_date ASC, id ASC
  `) as Row[];
}

async function fetchRatePoints(curveId: string | null | undefined): Promise<Row[]> {
  if (!curveId || curveId === 'null') return [];
  return (await sql`
    SELECT * FROM loan_rate_points WHERE curve_id = ${curveId} ORDER BY effective_date ASC, id ASC
  `) as Row[];
}

export async function previewSchedule(
  companyId: string,
  loanId: string,
  eventsOverride?: LoanEvent[],
): Promise<ScheduleRow[]> {
  const loanRow = await fetchLoanData(companyId, loanId);
  const loanInputs = loanRowToInputs(loanRow);

  let engineEvents: LoanEvent[];
  let pointRows: Row[];

  if (eventsOverride) {
    engineEvents = eventsOverride;
    pointRows = await fetchRatePoints(loanRow.curve_id as string | null);
  } else {
    const eventRows = await fetchEvents(companyId, loanId);
    pointRows = await fetchRatePoints(loanRow.curve_id as string | null);
    engineEvents = eventRows.map(dbEventToEngine);
  }

  const curve = pointRows
    .map(dbPointToEngine)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  return amortise(loanInputs, engineEvents, curve);
}

export async function getOrComputeSchedule(
  companyId: string,
  loanId: string,
): Promise<ScheduleResult> {
  const loanRow = await fetchLoanData(companyId, loanId, true);
  const eventRows = await fetchEvents(companyId, loanId);
  const pointRows = await fetchRatePoints(loanRow.curve_id as string | null);

  const hash = buildInputsHash(loanRow, eventRows, pointRows);

  // Check cache
  const runs = (await sql`
    SELECT * FROM loan_schedule_runs
    WHERE loan_id = ${loanId} AND inputs_hash = ${hash}
    ORDER BY computed_at DESC LIMIT 1
  `) as Row[];

  if (runs.length > 0) {
    const run = runs[0]!;
    const cachedRows = (await sql`
      SELECT * FROM loan_schedule_rows WHERE run_id = ${String(run.id)} ORDER BY period ASC
    `) as Row[];
    // Consumers take the LATEST run by computed_at; touch the hit so a revert
    // cannot leave a superseded run newest.
    const touched = (await sql`
      UPDATE loan_schedule_runs SET computed_at = now()
      WHERE id = ${String(run.id)} AND company_id = ${companyId}
      RETURNING computed_at
    `) as Row[];
    return {
      rows: cachedRows.map(mapDbRowToSchedule),
      runId: String(run.id),
      cached: true,
      computedAt: String(touched[0]?.computed_at ?? run.computed_at),
    };
  }

  // Compute
  const loanInputs = loanRowToInputs(loanRow);
  const engineEvents = eventRows.map(dbEventToEngine);
  const curve = pointRows
    .map(dbPointToEngine)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  const scheduleRows = amortise(loanInputs, engineEvents, curve);

  // Persist run
  const runRows = (await sql`
    INSERT INTO loan_schedule_runs (loan_id, company_id, engine_version, inputs_hash)
    VALUES (${loanId}, ${companyId}, ${ENGINE_VERSION}, ${hash})
    RETURNING *
  `) as Row[];
  const run = runRows[0]!;
  const runId = String(run.id);

  // Persist rows in ONE statement. The loan is share-locked until this
  // transaction commits, so a per-period round trip (360 on a 30-year term) made
  // every concurrent loan edit wait out the whole loop.
  const col = <T,>(f: (r: ScheduleRow) => T): T[] => scheduleRows.map(f);
  await sql`
    INSERT INTO loan_schedule_rows
      (run_id, period, date, opening, rate, installment, interest, principal,
       lump, skip_flag, payment, closing, st_liability, extrapolated, nca_flagged)
    SELECT ${runId}::uuid, * FROM unnest(
      ${col((r) => r.period)}::int[], ${col((r) => r.date)}::date[],
      ${col((r) => r.opening)}::numeric[], ${col((r) => r.rate)}::numeric[],
      ${col((r) => r.installment)}::numeric[], ${col((r) => r.interest)}::numeric[],
      ${col((r) => r.principal)}::numeric[], ${col((r) => r.lump)}::numeric[],
      ${col((r) => r.skip)}::boolean[], ${col((r) => r.payment)}::numeric[],
      ${col((r) => r.closing)}::numeric[], ${col((r) => r.stLiability)}::numeric[],
      ${col((r) => r.extrapolated)}::boolean[], ${col((r) => r.nca_flagged)}::boolean[]
    )
  `;

  log.info('Computed and cached schedule', { loanId, runId, periods: scheduleRows.length }, 'loans');
  return {
    rows: scheduleRows,
    runId,
    cached: false,
    computedAt: String(run.computed_at ?? new Date().toISOString()),
  };
}

export async function getPortfolioSummary(companyId: string): Promise<PortfolioSummary> {
  const rows = (await sql`
    SELECT
      COUNT(*)                                                                      AS total_loans,
      COUNT(*) FILTER (WHERE l.status = 'active')                                  AS active_count,
      COUNT(*) FILTER (WHERE l.status = 'closed')                                  AS closed_count,

      -- Actuals: original principal minus recorded principal payments
      COALESCE(SUM(l.principal - COALESCE(pp.total_principal_paid, 0))
        FILTER (WHERE l.status = 'active'), 0)                                    AS total_outstanding,
      -- Projection: closing balance from latest schedule run (period 1 row)
      COALESCE(SUM(lsr.closing) FILTER (WHERE l.status = 'active'), 0)            AS total_outstanding_projected,
      -- Weighted avg rate by actual remaining principal balance
      COALESCE(
        SUM(COALESCE(l.fixed_rate, 0) * (l.principal - COALESCE(pp.total_principal_paid, 0)))
          FILTER (WHERE l.status = 'active')
        / NULLIF(
            SUM(l.principal - COALESCE(pp.total_principal_paid, 0))
              FILTER (WHERE l.status = 'active'), 0),
        0
      )                                                                            AS weighted_avg_rate,
      -- Current portion: st_liability from latest schedule row 1
      COALESCE(SUM(lsr.st_liability) FILTER (WHERE l.status = 'active'), 0)       AS total_current_portion,
      -- Next-12m interest: forecast from schedule rows dated after today
      COALESCE(SUM(next12.interest_sum), 0)                                        AS next_12m_interest

    FROM loans l

    -- Actual principal paid per loan
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(lp.principal), 0) AS total_principal_paid
      FROM loan_payments lp
      WHERE lp.loan_id = l.id AND lp.company_id = ${companyId}
    ) pp ON true

    -- Latest schedule run first row: closing + st_liability
    LEFT JOIN LATERAL (
      SELECT lsr2.closing, lsr2.st_liability
      FROM loan_schedule_rows lsr2
      WHERE lsr2.run_id = (
        SELECT r2.id FROM loan_schedule_runs r2
        WHERE r2.loan_id = l.id ORDER BY r2.computed_at DESC LIMIT 1
      )
      ORDER BY lsr2.period ASC LIMIT 1
    ) lsr ON true

    -- Future 12-month interest from latest schedule
    LEFT JOIN LATERAL (
      SELECT SUM(lsr3.interest) AS interest_sum
      FROM loan_schedule_rows lsr3
      WHERE lsr3.run_id = (
        SELECT r3.id FROM loan_schedule_runs r3
        WHERE r3.loan_id = l.id ORDER BY r3.computed_at DESC LIMIT 1
      )
        AND lsr3.date > CURRENT_DATE
        AND lsr3.date <= CURRENT_DATE + INTERVAL '12 months'
    ) next12 ON true

    WHERE l.company_id = ${companyId}
  `) as Row[];

  const r = rows[0] ?? {};
  return {
    totalLoans: Number(r.total_loans ?? 0),
    totalOutstanding: parseFloat(String(r.total_outstanding ?? '0')),
    totalOutstandingProjected: parseFloat(String(r.total_outstanding_projected ?? '0')),
    weightedAvgRate: parseFloat(String(r.weighted_avg_rate ?? '0')),
    next12mInterest: parseFloat(String(r.next_12m_interest ?? '0')),
    totalCurrentPortion: parseFloat(String(r.total_current_portion ?? '0')),
    activeCount: Number(r.active_count ?? 0),
    closedCount: Number(r.closed_count ?? 0),
  };
}
