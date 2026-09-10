/**
 * Practice Client Rate Override Service
 * Manages per-staff billing rate overrides for specific clients.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';

export interface ClientRateOverride {
  id: string;
  companyId: string;
  clientId: string;
  staffUserId: string;
  ratePerHour: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  staffEmail: string | null;
  staffName: string | null;
}

export interface CreateRateOverrideInput {
  staffUserId: string;
  ratePerHour: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export interface UpdateRateOverrideInput {
  ratePerHour?: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

export interface CompanyStaffMember {
  userId: string;
  email: string | null;
  fullName: string | null;
}

function mapRow(row: Record<string, unknown>): ClientRateOverride {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    clientId: row.client_id as string,
    staffUserId: (row.staff_user_id ?? row.user_id) as string,
    ratePerHour: Number(row.rate_per_hour ?? row.rate),
    effectiveFrom: fmtDate(row.effective_from),
    effectiveTo: row.effective_to ? fmtDate(row.effective_to) : null,
    notes: (row.notes as string | null) ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    staffEmail: (row.staff_email as string | null) ?? null,
    staffName: (row.staff_name as string | null) ?? null,
  };
}

export async function listClientRateOverrides(
  companyId: string,
  clientId: string
): Promise<ClientRateOverride[]> {
  const rows = await sql`
    SELECT
      pcro.id,
      pcro.company_id,
      pcro.client_id,
      pcro.staff_user_id,
      pcro.user_id,
      pcro.rate_per_hour,
      pcro.rate,
      pcro.effective_from,
      pcro.effective_to,
      pcro.notes,
      pcro.created_at,
      pcro.updated_at,
      au.email AS staff_email,
      au.raw_user_meta_data->>'full_name' AS staff_name
    FROM practice_client_rate_overrides pcro
    LEFT JOIN auth.users au ON au.id::text = COALESCE(pcro.staff_user_id, pcro.user_id)::text
    WHERE pcro.company_id = ${companyId}
      AND pcro.client_id = ${clientId}
    ORDER BY pcro.effective_from DESC
  `;
  return rows.map(mapRow);
}

export async function createClientRateOverride(
  companyId: string,
  clientId: string,
  input: CreateRateOverrideInput
): Promise<ClientRateOverride> {
  log.info('Creating client rate override', { companyId, clientId, staffUserId: input.staffUserId }, 'Practice');

  const rows = await sql`
    INSERT INTO practice_client_rate_overrides
      (company_id, client_id, staff_user_id, user_id, rate_per_hour, rate, effective_from, effective_to, notes)
    VALUES
      (${companyId}, ${clientId}, ${input.staffUserId}, ${input.staffUserId},
       ${input.ratePerHour}, ${input.ratePerHour},
       ${input.effectiveFrom}, ${input.effectiveTo ?? null}, ${input.notes ?? null})
    RETURNING *
  `;

  const inserted = rows[0];
  if (!inserted) throw new Error('Insert returned no rows');

  const withUser = await sql`
    SELECT
      pcro.*,
      au.email AS staff_email,
      au.raw_user_meta_data->>'full_name' AS staff_name
    FROM practice_client_rate_overrides pcro
    LEFT JOIN auth.users au ON au.id::text = COALESCE(pcro.staff_user_id, pcro.user_id)::text
    WHERE pcro.id = ${inserted.id as string}
      AND pcro.company_id = ${companyId}
  `;

  return mapRow(withUser[0]!);
}

export async function updateClientRateOverride(
  companyId: string,
  clientId: string,
  overrideId: string,
  input: UpdateRateOverrideInput
): Promise<ClientRateOverride | null> {
  const rows = await sql`
    UPDATE practice_client_rate_overrides
    SET
      rate_per_hour  = COALESCE(${input.ratePerHour ?? null}, rate_per_hour),
      rate           = COALESCE(${input.ratePerHour ?? null}, rate),
      effective_from = COALESCE(${input.effectiveFrom ?? null}, effective_from),
      effective_to   = ${input.effectiveTo !== undefined ? (input.effectiveTo ?? null) : sql`effective_to`},
      notes          = ${input.notes !== undefined ? (input.notes ?? null) : sql`notes`},
      updated_at     = NOW()
    WHERE id         = ${overrideId}
      AND company_id = ${companyId}
      AND client_id  = ${clientId}
    RETURNING *
  `;

  if (rows.length === 0) return null;

  const withUser = await sql`
    SELECT
      pcro.*,
      au.email AS staff_email,
      au.raw_user_meta_data->>'full_name' AS staff_name
    FROM practice_client_rate_overrides pcro
    LEFT JOIN auth.users au ON au.id::text = COALESCE(pcro.staff_user_id, pcro.user_id)::text
    WHERE pcro.id = ${overrideId}
      AND pcro.company_id = ${companyId}
  `;

  return withUser[0] ? mapRow(withUser[0]) : null;
}

export async function deleteClientRateOverride(
  companyId: string,
  clientId: string,
  overrideId: string
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM practice_client_rate_overrides
    WHERE id         = ${overrideId}
      AND company_id = ${companyId}
      AND client_id  = ${clientId}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function listCompanyStaff(companyId: string): Promise<CompanyStaffMember[]> {
  const rows = await sql`
    SELECT
      cu.user_id,
      au.email,
      au.raw_user_meta_data->>'full_name' AS full_name
    FROM company_users cu
    LEFT JOIN auth.users au ON au.id::text = cu.user_id::text
    WHERE cu.company_id = ${companyId}
    ORDER BY au.email
  `;
  return rows.map((row) => ({
    userId: row.user_id as string,
    email: (row.email as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
  }));
}
