import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface RateCurve {
  id: string;
  companyId: string;
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
    companyId: String(row.company_id),
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
    effectiveDate: String(row.effective_date).slice(0, 10),
    rate: parseFloat(String(row.rate)),
  };
}

export async function listRateCurves(companyId: string): Promise<RateCurve[]> {
  const rows = (await sql`
    SELECT * FROM loan_rate_curves
    WHERE company_id = ${companyId}
    ORDER BY name
  `) as Row[];
  return rows.map(mapCurveRow);
}

export async function getRateCurveWithPoints(
  companyId: string,
  curveId: string,
): Promise<RateCurveWithPoints | null> {
  const curves = (await sql`
    SELECT * FROM loan_rate_curves
    WHERE id = ${curveId} AND company_id = ${companyId}
  `) as Row[];
  if (curves.length === 0) return null;

  const points = (await sql`
    SELECT * FROM loan_rate_points
    WHERE curve_id = ${curveId}
    ORDER BY effective_date ASC
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
    WHERE lrp.curve_id = ${curveId} AND lrc.company_id = ${companyId}
    ORDER BY lrp.effective_date ASC
  `) as Row[];
  return rows
    .map(mapPointRow)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}
