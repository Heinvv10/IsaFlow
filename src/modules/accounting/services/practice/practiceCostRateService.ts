import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StaffCostRate {
  id: string;
  companyId: string;
  userId: string;
  costRate: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface StaffCostRateInput {
  userId: string;
  costRate: number;
  currency?: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function mapRow(r: DbRow): StaffCostRate {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    costRate: Number(r.cost_rate),
    currency: String(r.currency),
    effectiveFrom: String(r.effective_from),
    effectiveTo: r.effective_to ? String(r.effective_to) : null,
    notes: r.notes ? String(r.notes) : null,
    createdBy: r.created_by ? String(r.created_by) : null,
    createdAt: String(r.created_at),
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateInput(input: Partial<StaffCostRateInput>): void {
  if (input.costRate !== undefined && input.costRate < 0) {
    throw new Error('cost rate must be >= 0');
  }
}

// ─── Functions ────────────────────────────────────────────────────────────────

export async function listCostRates(
  companyId: string,
  userId?: string,
): Promise<StaffCostRate[]> {
  const userIdParam = userId ?? null;
  const rows = (await sql`
    SELECT * FROM practice_staff_cost_rates
    WHERE company_id = ${companyId}::UUID
      AND (${userIdParam}::UUID IS NULL OR user_id = ${userIdParam}::UUID)
    ORDER BY effective_from DESC
  `) as DbRow[];
  return rows.map(mapRow);
}

export async function getCostRate(
  companyId: string,
  id: string,
): Promise<StaffCostRate | null> {
  const rows = (await sql`
    SELECT * FROM practice_staff_cost_rates
    WHERE company_id = ${companyId}::UUID AND id = ${id}::UUID
  `) as DbRow[];
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function createCostRate(
  companyId: string,
  createdBy: string,
  input: StaffCostRateInput,
): Promise<StaffCostRate> {
  validateInput(input);
  if (!input.effectiveFrom) throw new Error('effectiveFrom is required');

  const rows = (await sql`
    INSERT INTO practice_staff_cost_rates
      (company_id, user_id, cost_rate, currency, effective_from, effective_to, notes, created_by)
    VALUES (
      ${companyId}::UUID,
      ${input.userId}::UUID,
      ${input.costRate},
      ${input.currency ?? 'ZAR'},
      ${input.effectiveFrom}::DATE,
      ${input.effectiveTo ?? null}::DATE,
      ${input.notes ?? null},
      ${createdBy}::UUID
    ) RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert');
  log.info('Created staff cost rate', { id: rows[0].id, userId: input.userId }, 'practice');
  return mapRow(rows[0]);
}

export async function updateCostRate(
  companyId: string,
  id: string,
  input: Partial<StaffCostRateInput>,
): Promise<StaffCostRate> {
  validateInput(input);

  const existing = (await sql`
    SELECT id FROM practice_staff_cost_rates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_staff_cost_rates SET
      cost_rate      = COALESCE(${input.costRate ?? null}, cost_rate),
      currency       = COALESCE(${input.currency ?? null}, currency),
      effective_from = COALESCE(${input.effectiveFrom ?? null}::DATE, effective_from),
      effective_to   = CASE
                         WHEN ${input.effectiveTo !== undefined ? 'true' : 'false'} = 'true'
                         THEN ${input.effectiveTo ?? null}::DATE
                         ELSE effective_to
                       END,
      notes          = COALESCE(${input.notes ?? null}, notes)
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after update');
  log.info('Updated staff cost rate', { id }, 'practice');
  return mapRow(rows[0]);
}

export async function deleteCostRate(
  companyId: string,
  id: string,
): Promise<void> {
  await sql`
    DELETE FROM practice_staff_cost_rates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deleted staff cost rate', { id }, 'practice');
}

export async function resolveCostRate(
  companyId: string,
  userId: string,
  onDate: string,
): Promise<number | null> {
  const rows = (await sql`
    SELECT cost_rate FROM practice_staff_cost_rates
    WHERE company_id = ${companyId}::UUID
      AND user_id = ${userId}::UUID
      AND effective_from <= ${onDate}::DATE
      AND (effective_to IS NULL OR effective_to >= ${onDate}::DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `) as DbRow[];

  if (!rows.length) {
    log.warn('resolveCostRate: no cost rate found', { companyId, userId, onDate }, 'practice');
    return null;
  }
  return Number(rows[0]!.cost_rate);
}
