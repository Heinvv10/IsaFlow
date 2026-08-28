import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface RateCurve {
  id: string;
  /** null when the curve is a system-level curve shared across tenants. */
  companyId: string | null;
  name: string;
  source: string | null;
  isSystem: boolean;
  createdAt: string;
}

export interface RatePoint {
  id: string;
  curveId: string;
  effectiveDate: string;
  rate: number;
}

export interface RateCurveWithPoints extends RateCurve {
  points: RatePoint[];
}

export interface RateCurveCreateInput {
  name: string;
  source?: string;
  isSystem?: boolean;
}

export interface RatePointInput {
  effectiveDate: string;
  rate: number;
}

function mapCurveRow(row: Row): RateCurve {
  return {
    id: String(row.id),
    companyId: row.company_id != null ? String(row.company_id) : null,
    name: String(row.name),
    source: row.source != null ? String(row.source) : null,
    isSystem: Boolean(row.is_system),
    createdAt: String(row.created_at),
  };
}

function mapPointRow(row: Row): RatePoint {
  return {
    id: String(row.id),
    curveId: String(row.curve_id),
    effectiveDate: fmtDate(row.effective_date),
    rate: parseFloat(String(row.rate)),
  };
}

export async function listRateCurves(companyId: string): Promise<RateCurve[]> {
  // System curves (company_id IS NULL, is_system = true) are shared across
  // tenants for read access. Seeded by migration 393 (SA Prime).
  const rows = (await sql`
    SELECT * FROM loan_rate_curves
    WHERE company_id = ${companyId}
       OR (is_system = true AND company_id IS NULL)
    ORDER BY is_system DESC, name
  `) as Row[];
  return rows.map(mapCurveRow);
}

export async function getRateCurveWithPoints(
  companyId: string,
  curveId: string,
): Promise<RateCurveWithPoints | null> {
  const curves = (await sql`
    SELECT * FROM loan_rate_curves
    WHERE id = ${curveId}
      AND (company_id = ${companyId} OR (is_system = true AND company_id IS NULL))
  `) as Row[];
  if (curves.length === 0) return null;

  // Defence-in-depth: join back to loan_rate_curves with company_id so a
  // caller can never pull points for a curve that doesn't belong to them,
  // even if the ownership gate above is ever removed. Allow system curves.
  const points = (await sql`
    SELECT lrp.* FROM loan_rate_points lrp
    JOIN loan_rate_curves lrc ON lrc.id = lrp.curve_id
    WHERE lrp.curve_id = ${curveId}
      AND (lrc.company_id = ${companyId} OR (lrc.is_system = true AND lrc.company_id IS NULL))
    ORDER BY lrp.effective_date ASC
  `) as Row[];

  return {
    ...mapCurveRow(curves[0]!),
    points: points
      .map(mapPointRow)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
  };
}

export async function createRateCurve(
  companyId: string,
  input: RateCurveCreateInput,
): Promise<RateCurve> {
  if (!input.name || !input.name.trim()) throw new Error('name is required');

  const rows = (await sql`
    INSERT INTO loan_rate_curves (company_id, name, source, is_system)
    VALUES (${companyId}, ${input.name.trim()}, ${input.source ?? null}, ${input.isSystem ?? false})
    RETURNING *
  `) as Row[];

  log.info('Created rate curve', { companyId, name: input.name }, 'loans');
  return mapCurveRow(rows[0]!);
}

export async function upsertRatePoints(
  companyId: string,
  curveId: string,
  points: RatePointInput[],
): Promise<number> {
  if (points.length === 0) throw new Error('at least one rate point required');
  for (const p of points) {
    if (p.rate <= 0) throw new Error('rate must be positive');
  }

  // Multi-tenant guard: the curve must belong to the caller's company
  const owners = (await sql`
    SELECT id FROM loan_rate_curves WHERE id = ${curveId} AND company_id = ${companyId}
  `) as Row[];
  if (owners.length === 0) throw new Error(`Rate curve ${curveId} not found`);

  let inserted = 0;
  for (const p of points) {
    await sql`
      INSERT INTO loan_rate_points (curve_id, effective_date, rate)
      VALUES (${curveId}, ${p.effectiveDate}, ${p.rate})
      ON CONFLICT (curve_id, effective_date) DO UPDATE SET rate = EXCLUDED.rate
    `;
    inserted++;
  }

  log.info('Upserted rate points', { curveId, count: inserted }, 'loans');
  return inserted;
}

export async function getRatePointsForCurve(
  companyId: string,
  curveId: string,
): Promise<RatePoint[]> {
  const rows = (await sql`
    SELECT lrp.* FROM loan_rate_points lrp
    JOIN loan_rate_curves lrc ON lrc.id = lrp.curve_id
    WHERE lrp.curve_id = ${curveId}
      AND (lrc.company_id = ${companyId} OR (lrc.is_system = true AND lrc.company_id IS NULL))
    ORDER BY lrp.effective_date ASC
  `) as Row[];
  return rows
    .map(mapPointRow)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}
