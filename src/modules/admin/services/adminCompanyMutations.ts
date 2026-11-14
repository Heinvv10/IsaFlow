/**
 * Admin Company Mutations — edit, suspend, activate and create a company for
 * the IsaFlow Admin Platform. Re-exported by adminCompanyService.ts, so callers
 * (and their vi.mock of that module) are unchanged. Every mutation should be
 * followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AdminCompanyDetail } from '../types/admin.types';

/**
 * A key that is undefined keeps the column; null (or '') clears it; a string sets it (audit 4.17: COALESCE
 * made a cleared field come back). The name is required, so it is only ever replaced.
 */
export async function updateCompany(
  companyId: string,
  data: Partial<AdminCompanyDetail>
): Promise<void> {
  // Only update safe, explicitly listed fields
  const {
    name, trading_name, phone, email, website,
    billing_email, billing_contact,
    address_line1, city, province, postal_code,
  } = data;
  const has = (v: string | null | undefined) => v !== undefined;
  const val = (v: string | null | undefined) => (v == null || v === '' ? null : v);

  await sql`
    UPDATE companies SET
      name             = COALESCE(${name ?? null}, name),
      trading_name     = CASE WHEN ${has(trading_name)}    THEN ${val(trading_name)}    ELSE trading_name END,
      phone            = CASE WHEN ${has(phone)}           THEN ${val(phone)}           ELSE phone END,
      email            = CASE WHEN ${has(email)}           THEN ${val(email)}           ELSE email END,
      website          = CASE WHEN ${has(website)}         THEN ${val(website)}         ELSE website END,
      billing_email    = CASE WHEN ${has(billing_email)}   THEN ${val(billing_email)}   ELSE billing_email END,
      billing_contact  = CASE WHEN ${has(billing_contact)} THEN ${val(billing_contact)} ELSE billing_contact END,
      address_line1    = CASE WHEN ${has(address_line1)}   THEN ${val(address_line1)}   ELSE address_line1 END,
      city             = CASE WHEN ${has(city)}            THEN ${val(city)}            ELSE city END,
      province         = CASE WHEN ${has(province)}        THEN ${val(province)}        ELSE province END,
      postal_code      = CASE WHEN ${has(postal_code)}     THEN ${val(postal_code)}     ELSE postal_code END,
      updated_at       = NOW()
    WHERE id = ${companyId}
  `;

  log.info('updateCompany', { companyId }, 'AdminCompanyService');
}

/** Suspend. A deleted company is refused (false): suspending would undelete it. */
export async function suspendCompany(
  companyId: string,
  reason: string
): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE companies
    SET status           = 'suspended',
        suspended_reason = ${reason},
        suspended_at     = NOW(),
        updated_at       = NOW()
    WHERE id = ${companyId}
      AND status IS DISTINCT FROM 'deleted'
    RETURNING id
  `;
  log.info('suspendCompany', { companyId, reason, suspended: rows.length > 0 }, 'AdminCompanyService');
  return rows.length > 0;
}

/**
 * Lift a suspension. A deleted company is refused (false): it comes back only
 * through companyLifecycleService.restoreCompany, which also restarts billing.
 */
export async function activateCompany(companyId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE companies
    SET status           = 'active',
        suspended_reason = NULL,
        suspended_at     = NULL,
        updated_at       = NOW()
    WHERE id = ${companyId}
      AND status IS DISTINCT FROM 'deleted'
    RETURNING id
  `;
  log.info('activateCompany', { companyId, activated: rows.length > 0 }, 'AdminCompanyService');
  return rows.length > 0;
}

export async function createCompany(input: {
  name: string;
  trading_name?: string | null;
  email?: string | null;
  phone?: string | null;
  plan_id?: string | null;
  annual_turnover_cents?: number | null;
  payg_eligible?: boolean;
}): Promise<{ id: string; name: string }> {
  const rows = await sql`
    INSERT INTO companies (
      name, registered_name, trading_name, email, phone, country, default_currency, status,
      annual_turnover_cents, payg_eligible
    ) VALUES (
      ${input.name},
      ${input.name},
      ${input.trading_name ?? null},
      ${input.email ?? null},
      ${input.phone ?? null},
      'South Africa',
      'ZAR',
      'active',
      ${input.annual_turnover_cents ?? null},
      ${input.payg_eligible ?? false}
    )
    RETURNING id, name
  `;
  const created = rows[0] as { id: string; name: string };

  if (input.plan_id) {
    await sql`
      INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, current_period_start)
      VALUES (${created.id}::uuid, ${input.plan_id}::uuid, 'trial', 'monthly', NOW())
    `;
  }

  log.info('createCompany (admin)', { id: created.id, name: created.name, plan_id: input.plan_id ?? null }, 'AdminCompanyService');
  return created;
}
