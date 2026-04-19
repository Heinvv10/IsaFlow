import crypto from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanInputs, LoanEvent, RatePoint, ScheduleRow } from '@/lib/amortisation/types';

type Row = DbRow;

const ENGINE_VERSION = '1.0.0';

export interface ScheduleResult {
  rows: ScheduleRow[];
  runId: string | null;
  cached: boolean;
  computedAt: string;
}

export interface PortfolioSummary {
  totalLoans: number;
  totalOutstanding: number;
  weightedAvgRate: number;
  next12mInterest: number;
  totalCurrentPortion: number;
  activeCount: number;
  closedCount: number;
}

function mapDbRowToSchedule(r: Row): ScheduleRow {
  return {
    period: Number(r.period),
    date: String(r.date).slice(0, 10),
    opening: parseFloat(String(r.opening ?? '0')),
    rate: parseFloat(String(r.rate ?? '0')),
    installment: parseFloat(String(r.installment ?? '0')),
    interest: parseFloat(String(r.interest ?? '0')),
    principal: parseFloat(String(r.principal ?? '0')),
    intPortion: parseFloat(String(r.interest ?? '0')),
    skip: Boolean(r.skip_flag),
    payment: parseFloat(String(r.payment ?? '0')),
    lump: parseFloat(String(r.lump ?? '0')),
    closing: parseFloat(String(r.closing ?? '0')),
    stLiability: parseFloat(String(r.st_liability ?? '0')),
    extrapolated: Boolean(r.extrapolated),
    nca_flagged: Boolean(r.nca_flagged),
  };
}

function loanRowToInputs(row: Row): LoanInputs {
  return {
    id: String(row.id),
    principal: parseFloat(String(row.principal)),
    startDate: String(row.start_date).slice(0, 10),
    termMonths: Number(row.term_months),
    rateMode: String(row.rate_mode) as LoanInputs['rateMode'],
    margin: parseFloat(String(row.margin ?? '0')),
    fixedRate: row.fixed_rate != null ? parseFloat(String(row.fixed_rate)) : undefined,
    residual: parseFloat(String(row.residual ?? '0')),
    recurringSkipMonths: Array.isArray(row.recurring_skip_months)
      ? (row.recurring_skip_months as number[])
      : [],
    dayCount: String(row.day_count) as LoanInputs['dayCount'],
    repriceMode: String(row.reprice_mode) as LoanInputs['repriceMode'],
    skipMode: String(row.skip_mode) as LoanInputs['skipMode'],
    lumpMode: String(row.lump_mode) as LoanInputs['lumpMode'],
  };
}

function dbEventToEngine(r: Row): LoanEvent {
  return {
    kind: String(r.kind) as LoanEvent['kind'],
    date: String(r.event_date).slice(0, 10),
    amount: r.amount != null ? parseFloat(String(r.amount)) : undefined,
    note: r.note != null ? String(r.note) : undefined,
  };
}

function dbPointToEngine(r: Row): RatePoint {
  return {
    effectiveDate: String(r.effective_date).slice(0, 10),
    rate: parseFloat(String(r.rate)),
  };
}

function buildInputsHash(loan: Row, events: Row[], points: Row[]): string {
  const payload = JSON.stringify({ loan: loan.id, events, points });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function fetchLoanData(companyId: string, loanId: string) {
  const loans = (await sql`
    SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId}
  `) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);
  return loans[0]!;
}

async function fetchEvents(companyId: string, loanId: string): Promise<Row[]> {
  return (await sql`
    SELECT * FROM loan_events
    WHERE loan_id = ${loanId} AND company_id = ${companyId}
    ORDER BY event_date ASC
  `) as Row[];
}

async function fetchRatePoints(curveId: string): Promise<Row[]> {
  return (await sql`
    SELECT * FROM loan_rate_points WHERE curve_id = ${curveId} ORDER BY effective_date ASC
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
    pointRows = await fetchRatePoints(String(loanRow.curve_id));
  } else {
    const eventRows = await fetchEvents(companyId, loanId);
    pointRows = await fetchRatePoints(String(loanRow.curve_id));
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
  const loanRow = await fetchLoanData(companyId, loanId);
  const eventRows = await fetchEvents(companyId, loanId);
  const pointRows = await fetchRatePoints(String(loanRow.curve_id));

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
    return {
      rows: cachedRows.map(mapDbRowToSchedule),
      runId: String(run.id),
      cached: true,
      computedAt: String(run.computed_at),
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

  // Persist rows
  for (const r of scheduleRows) {
    await sql`
      INSERT INTO loan_schedule_rows
        (run_id, period, date, opening, rate, installment, interest, principal,
         lump, skip_flag, payment, closing, st_liability, extrapolated, nca_flagged)
      VALUES
        (${runId}, ${r.period}, ${r.date}, ${r.opening}, ${r.rate}, ${r.installment},
         ${r.interest}, ${r.principal}, ${r.lump}, ${r.skip}, ${r.payment},
         ${r.closing}, ${r.stLiability}, ${r.extrapolated}, ${r.nca_flagged})
    `;
  }

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
      COUNT(*)                                           AS total_loans,
      SUM(l.principal)                                   AS total_outstanding,
      AVG(CASE WHEN l.rate_mode = 'FIXED' THEN l.fixed_rate
               ELSE NULL END)                            AS weighted_avg_rate,
      SUM(lsr.st_liability)                              AS total_current_portion,
      COALESCE(SUM(next12.interest_sum), 0)              AS next_12m_interest,
      COUNT(*) FILTER (WHERE l.status = 'active')        AS active_count,
      COUNT(*) FILTER (WHERE l.status = 'closed')        AS closed_count
    FROM loans l
    LEFT JOIN LATERAL (
      SELECT lsr2.st_liability, lsr2.interest
      FROM loan_schedule_rows lsr2
      WHERE lsr2.run_id = (
        SELECT r2.id FROM loan_schedule_runs r2
        WHERE r2.loan_id = l.id
        ORDER BY r2.computed_at DESC
        LIMIT 1
      )
      ORDER BY lsr2.period ASC
      LIMIT 1
    ) lsr ON true
    LEFT JOIN LATERAL (
      SELECT SUM(lsr3.interest) AS interest_sum
      FROM loan_schedule_rows lsr3
      WHERE lsr3.run_id = (
        SELECT r3.id FROM loan_schedule_runs r3
        WHERE r3.loan_id = l.id
        ORDER BY r3.computed_at DESC
        LIMIT 1
      )
        AND lsr3.period BETWEEN 1 AND 12
    ) next12 ON true
    WHERE l.company_id = ${companyId}
  `) as Row[];

  const r = rows[0] ?? {};
  return {
    totalLoans: Number(r.total_loans ?? 0),
    totalOutstanding: parseFloat(String(r.total_outstanding ?? '0')),
    weightedAvgRate: parseFloat(String(r.weighted_avg_rate ?? '0')),
    next12mInterest: parseFloat(String(r.next_12m_interest ?? '0')),
    totalCurrentPortion: parseFloat(String(r.total_current_portion ?? '0')),
    activeCount: Number(r.active_count ?? 0),
    closedCount: Number(r.closed_count ?? 0),
  };
}
