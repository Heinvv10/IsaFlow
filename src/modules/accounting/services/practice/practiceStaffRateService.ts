import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface StaffRate {
  id: string;
  companyId: string;
  userId: string;
  rate: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface ClientRateOverride {
  id: string;
  companyId: string;
  clientId: string;
  userId: string;
  rate: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

function mapRate(r: DbRow): StaffRate {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    rate: Number(r.rate),
    currency: String(r.currency),
    effectiveFrom: String(r.effective_from),
    effectiveTo: r.effective_to ? String(r.effective_to) : null,
    createdAt: String(r.created_at),
  };
}

function mapOverride(r: DbRow): ClientRateOverride {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    rate: Number(r.rate),
    effectiveFrom: String(r.effective_from),
    effectiveTo: r.effective_to ? String(r.effective_to) : null,
    createdAt: String(r.created_at),
  };
}

export async function listStaffRates(companyId: string, userId: string): Promise<StaffRate[]> {
  const rows = (await sql`
    SELECT * FROM practice_staff_rates
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
    ORDER BY effective_from DESC
  `) as DbRow[];
  return rows.map(mapRate);
}

export async function createStaffRate(
  companyId: string,
  input: { userId: string; rate: number; currency?: string; effectiveFrom: string; effectiveTo?: string },
): Promise<StaffRate> {
  const rows = (await sql`
    INSERT INTO practice_staff_rates (company_id, user_id, rate, currency, effective_from, effective_to)
    VALUES (
      ${companyId}::UUID, ${input.userId}::UUID, ${input.rate},
      ${input.currency ?? 'ZAR'}, ${input.effectiveFrom}::DATE,
      ${input.effectiveTo ?? null}::DATE
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created staff rate', { id: rows[0].id, userId: input.userId }, 'practice');
  return mapRate(rows[0]);
}

export async function updateStaffRate(
  companyId: string,
  id: string,
  input: { effectiveTo?: string; rate?: number },
): Promise<StaffRate> {
  const existing = (await sql`
    SELECT id FROM practice_staff_rates WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_staff_rates SET
      rate         = COALESCE(${input.rate ?? null}, rate),
      effective_to = COALESCE(${input.effectiveTo ?? null}::DATE, effective_to)
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapRate(rows[0]);
}

export async function resolveRate(
  companyId: string,
  userId: string,
  clientId: string,
  onDate: string,
): Promise<number | null> {
  const override = (await sql`
    SELECT rate FROM practice_client_rate_overrides
    WHERE company_id = ${companyId}::UUID
      AND user_id    = ${userId}::UUID
      AND client_id  = ${clientId}::UUID
      AND effective_from <= ${onDate}::DATE
      AND (effective_to IS NULL OR effective_to >= ${onDate}::DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `) as DbRow[];
  if (override.length) return Number(override[0]!.rate);

  const staff = (await sql`
    SELECT rate FROM practice_staff_rates
    WHERE company_id     = ${companyId}::UUID
      AND user_id        = ${userId}::UUID
      AND effective_from <= ${onDate}::DATE
      AND (effective_to IS NULL OR effective_to >= ${onDate}::DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `) as DbRow[];
  if (staff.length) return Number(staff[0]!.rate);

  log.warn('resolveRate: no rate found', { companyId, userId, clientId, onDate }, 'practice');
  return null;
}

export async function listClientRateOverrides(companyId: string, clientId: string): Promise<ClientRateOverride[]> {
  const rows = (await sql`
    SELECT * FROM practice_client_rate_overrides
    WHERE company_id = ${companyId}::UUID AND client_id = ${clientId}::UUID
    ORDER BY effective_from DESC
  `) as DbRow[];
  return rows.map(mapOverride);
}

export async function createClientRateOverride(
  companyId: string,
  input: { clientId: string; userId: string; rate: number; effectiveFrom: string; effectiveTo?: string },
): Promise<ClientRateOverride> {
  const rows = (await sql`
    INSERT INTO practice_client_rate_overrides (company_id, client_id, user_id, rate, effective_from, effective_to)
    VALUES (
      ${companyId}::UUID, ${input.clientId}::UUID, ${input.userId}::UUID,
      ${input.rate}, ${input.effectiveFrom}::DATE, ${input.effectiveTo ?? null}::DATE
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapOverride(rows[0]);
}
