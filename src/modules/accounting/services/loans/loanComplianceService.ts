import Decimal from 'decimal.js';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { amortise } from '@/lib/amortisation/engine';
import type { LoanInputs, RatePoint, ScheduleRow } from '@/lib/amortisation/types';

type Row = DbRow;

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ── Types ────────────────────────────────────────────────────────────────────

export type EclStage = 1 | 2 | 3;
export type EclMethod = '12m' | 'lifetime' | 'full';

export interface NcaResult {
  flagged: boolean;
  firstBreachPeriod: number | null;
  breachCount: number;
}

export interface EclResult {
  stage: EclStage;
  method: EclMethod;
  amount: number;
}

export interface NpvImpactResult {
  oldNpv: number;
  newNpv: number;
  deltaPct: number;     // |new - old| / |old| * 100
  substantial: boolean; // deltaPct > 10
}

export interface RateShock {
  bps: number;            // shift in basis points (e.g. +100, -200)
  interestNext12m: number; // total interest over the next 12 months under the shock
  interestDelta: number;  // interestNext12m − baseInterest12m
}

export interface RateSensitivityResult {
  baseInterest12m: number;
  minus200bp: RateShock;
  minus100bp: RateShock;
  plus100bp: RateShock;
  plus200bp: RateShock;
}

export interface Assessment {
  id: string;
  companyId: string;
  loanId: string;
  assessmentDate: string;
  ncaFlagged: boolean;
  ncaPeriod: number | null;
  stage: EclStage | null;
  daysPastDue: number;
  eclAmount: number;
  eclMethod: EclMethod | null;
  outstanding: number | null;
  notes: string | null;
  assessedBy: string | null;
  assessedAt: string;
}

// ── Pure compliance checks ──────────────────────────────────────────────────

export function checkNcaCompliance(schedule: ScheduleRow[]): NcaResult {
  const flagged = schedule.filter((r) => r.nca_flagged);
  if (flagged.length === 0) return { flagged: false, firstBreachPeriod: null, breachCount: 0 };
  return { flagged: true, firstBreachPeriod: flagged[0]!.period, breachCount: flagged.length };
}

export function determineEclStage(daysPastDue: number): EclStage {
  if (daysPastDue <= 30) return 1;
  if (daysPastDue <= 90) return 2;
  return 3;
}

export function computeEclAmount(
  stage: EclStage,
  outstanding: number,
  schedule: ScheduleRow[],
): EclResult {
  if (outstanding <= 0) return { stage, method: stage === 3 ? 'full' : stage === 2 ? 'lifetime' : '12m', amount: 0 };

  // Simplified ECL model — PD * LGD * EAD.
  // Real ECL requires counterparty credit rating + collateral; this is a conservative approximation.
  const PD_STAGE1 = 0.01;   // 1% 12-month PD
  const PD_STAGE2 = 0.10;   // 10% lifetime PD for under-performing
  const LGD = 0.45;         // 45% loss given default (Basel IRB default for unsecured)

  if (stage === 3) {
    return { stage, method: 'full', amount: outstanding };
  }

  if (stage === 2) {
    const amount = outstanding * PD_STAGE2 * LGD;
    return { stage, method: 'lifetime', amount: Math.max(0, amount) };
  }

  // Stage 1 — 12m ECL based on next 12 months of interest + partial principal
  const next12 = schedule.slice(0, 12);
  const exposure = next12.reduce((s, r) => s + r.interest + r.principal, 0);
  const amount = exposure * PD_STAGE1 * LGD;
  return { stage, method: '12m', amount: Math.max(0, amount) };
}

export function computeDaysPastDue(
  lastPaymentDate: string | null,
  asOfDate: string,
  scheduledDate?: string | null,
): number {
  if (!scheduledDate) return 0;
  const scheduled = new Date(scheduledDate).getTime();
  // If a payment arrived on or before schedule, no DPD.
  if (lastPaymentDate) {
    const paid = new Date(lastPaymentDate).getTime();
    if (paid <= scheduled) return 0;
    const diff = Math.round((paid - scheduled) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  }
  const asOf = new Date(asOfDate).getTime();
  if (asOf <= scheduled) return 0;
  return Math.max(0, Math.round((asOf - scheduled) / (1000 * 60 * 60 * 24)));
}

// ── NPV impact for modification accounting ──────────────────────────────────

function npvOfSchedule(schedule: ScheduleRow[], monthlyDiscountRate: number): Decimal {
  const r = new Decimal(monthlyDiscountRate);
  let total = new Decimal(0);
  for (const row of schedule) {
    const cashOut = new Decimal(row.payment).plus(row.lump);
    if (cashOut.isZero()) continue;
    const factor = r.plus(1).pow(row.period);
    total = total.plus(cashOut.div(factor));
  }
  return total;
}

export function computeNpvImpact(
  oldInputs: LoanInputs,
  newInputs: LoanInputs,
  curve: RatePoint[],
): NpvImpactResult {
  const oldSchedule = amortise(oldInputs, [], curve);
  const newSchedule = amortise(newInputs, [], curve);

  // Discount both at the ORIGINAL effective rate (IFRS 9 para 5.4.3)
  const origEffRate = oldInputs.rateMode === 'FIXED'
    ? (oldInputs.fixedRate ?? 0)
    : ((curve[0]?.rate ?? 0) + (oldInputs.rateMode === 'PRIME_PLUS' ? oldInputs.margin : -oldInputs.margin));
  const monthly = origEffRate / 1200;

  const oldNpv = npvOfSchedule(oldSchedule, monthly);
  const newNpv = npvOfSchedule(newSchedule, monthly);

  const delta = oldNpv.isZero() ? new Decimal(0) : newNpv.minus(oldNpv).div(oldNpv).times(100).abs();
  const deltaPct = delta.toNumber();
  return {
    oldNpv: oldNpv.toDecimalPlaces(2).toNumber(),
    newNpv: newNpv.toDecimalPlaces(2).toNumber(),
    deltaPct,
    substantial: deltaPct > 10,
  };
}

// ── computeRateSensitivity (pure, IFRS 7) ───────────────────────────────────

function shockCurve(curve: RatePoint[], bps: number): RatePoint[] {
  // +/-100bp etc. — shift every point by bps/100 percentage points.
  const delta = bps / 100;
  return curve.map((p) => ({ ...p, rate: Math.max(0, p.rate + delta) }));
}

function interestOverNext12m(inputs: LoanInputs, curve: RatePoint[]): number {
  const rows = amortise(inputs, [], curve);
  return rows.slice(0, 12).reduce((s, r) => s + r.interest, 0);
}

export function computeRateSensitivity(
  inputs: LoanInputs,
  curve: RatePoint[],
): RateSensitivityResult {
  const base = interestOverNext12m(inputs, curve);
  const mk = (bps: number): RateShock => {
    const shocked = bps === 0 ? curve : shockCurve(curve, bps);
    const interest = interestOverNext12m(inputs, shocked);
    return { bps, interestNext12m: interest, interestDelta: interest - base };
  };
  return {
    baseInterest12m: base,
    minus200bp: mk(-200),
    minus100bp: mk(-100),
    plus100bp: mk(100),
    plus200bp: mk(200),
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function dbRowToSchedule(r: Row): ScheduleRow {
  const interest = parseFloat(String(r.interest ?? '0'));
  return {
    period: Number(r.period),
    date: String(r.date).slice(0, 10),
    opening: parseFloat(String(r.opening ?? '0')),
    rate: parseFloat(String(r.rate ?? '0')),
    installment: parseFloat(String(r.installment ?? '0')),
    interest,
    principal: parseFloat(String(r.principal ?? '0')),
    intPortion: interest,
    skip: Boolean(r.skip_flag),
    payment: parseFloat(String(r.payment ?? '0')),
    lump: parseFloat(String(r.lump ?? '0')),
    closing: parseFloat(String(r.closing ?? '0')),
    stLiability: parseFloat(String(r.st_liability ?? '0')),
    extrapolated: Boolean(r.extrapolated),
    nca_flagged: Boolean(r.nca_flagged),
  };
}

function mapAssessment(r: Row): Assessment {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    loanId: String(r.loan_id),
    assessmentDate: String(r.assessment_date).slice(0, 10),
    ncaFlagged: Boolean(r.nca_flagged),
    ncaPeriod: r.nca_period != null ? Number(r.nca_period) : null,
    stage: r.ifrs9_stage != null ? Number(r.ifrs9_stage) as EclStage : null,
    daysPastDue: Number(r.days_past_due ?? 0),
    eclAmount: parseFloat(String(r.ecl_amount ?? '0')),
    eclMethod: r.ecl_method != null ? (String(r.ecl_method) as EclMethod) : null,
    outstanding: r.outstanding != null ? parseFloat(String(r.outstanding)) : null,
    notes: r.notes != null ? String(r.notes) : null,
    assessedBy: r.assessed_by != null ? String(r.assessed_by) : null,
    assessedAt: String(r.assessed_at),
  };
}

// ── assessLoan ─────────────────────────────────────────────────────────────

export async function assessLoan(
  companyId: string,
  loanId: string,
  userId: string,
  asOfDate: string,
): Promise<Assessment> {
  const loans = (await sql`
    SELECT * FROM loans WHERE id = ${loanId} AND company_id = ${companyId}
  `) as Row[];
  if (loans.length === 0) throw new Error(`Loan ${loanId} not found`);

  const runs = (await sql`
    SELECT id FROM loan_schedule_runs WHERE loan_id = ${loanId} ORDER BY computed_at DESC LIMIT 1
  `) as Row[];
  if (runs.length === 0) throw new Error('No schedule run exists — compute schedule first');

  const rowsDb = (await sql`
    SELECT * FROM loan_schedule_rows WHERE run_id = ${String(runs[0]!.id)} ORDER BY period ASC
  `) as Row[];
  const schedule = rowsDb.map(dbRowToSchedule);

  const nca = checkNcaCompliance(schedule);

  // Find latest posted payment to derive DPD
  const lastPay = (await sql`
    SELECT MAX(posting_date) AS last_payment_date
    FROM loan_gl_postings
    WHERE company_id = ${companyId} AND loan_id = ${loanId}
  `) as Row[];
  const lastPaymentDate = lastPay[0]?.last_payment_date != null
    ? String(lastPay[0]!.last_payment_date).slice(0, 10)
    : null;

  // The next scheduled row on or after asOfDate is the earliest unpaid
  const nextScheduled = schedule.find((r) => !r.skip && r.date >= asOfDate);
  const scheduledDate = nextScheduled ? nextScheduled.date : null;

  const dpd = computeDaysPastDue(lastPaymentDate, asOfDate, scheduledDate);
  const stage = determineEclStage(dpd);

  // Current outstanding = closing balance of the most recent scheduled row before/at asOfDate
  const currentRow = [...schedule].reverse().find((r) => r.date <= asOfDate) ?? schedule[0]!;
  const outstanding = currentRow.closing;

  const remainingSchedule = schedule.filter((r) => r.date > asOfDate);
  const ecl = computeEclAmount(stage, outstanding, remainingSchedule);

  const inserted = (await sql`
    INSERT INTO loan_compliance_assessments (
      company_id, loan_id, assessment_date,
      nca_flagged, nca_period, ifrs9_stage,
      days_past_due, ecl_amount, ecl_method,
      outstanding, assessed_by
    ) VALUES (
      ${companyId}, ${loanId}, ${asOfDate},
      ${nca.flagged}, ${nca.firstBreachPeriod}, ${stage},
      ${dpd}, ${ecl.amount}, ${ecl.method},
      ${outstanding}, ${userId}
    )
    RETURNING *
  `) as Row[];

  log.info('Assessed loan compliance', { loanId, stage, dpd, ncaFlagged: nca.flagged }, 'loans');
  return mapAssessment(inserted[0]!);
}

// ── listAssessments ─────────────────────────────────────────────────────────

export async function listAssessments(
  companyId: string,
  loanId: string,
): Promise<Assessment[]> {
  const rows = (await sql`
    SELECT * FROM loan_compliance_assessments
    WHERE company_id = ${companyId} AND loan_id = ${loanId}
    ORDER BY assessed_at DESC
  `) as Row[];
  return rows.map(mapAssessment);
}
