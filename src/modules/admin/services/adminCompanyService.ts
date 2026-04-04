/**
 * Admin Company Service
 * Cross-company management operations for the ISAFlow Admin Platform.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  AdminCompanyListItem,
  AdminCompanyDetail,
  AdminListFilters,
  PaginatedResult,
} from '../types/admin.types';

type Row = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  name: 'c.name',
  created_at: 'c.created_at',
  status: 'c.status',
  user_count: 'user_count',
  mrr_cents: 'mrr_cents',
};

export async function listCompanies(
  filters: AdminListFilters & { plan?: string } = {}
): Promise<PaginatedResult<AdminCompanyListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;
  const sortColKey = filters.sort_by ?? '';
  if (sortColKey && !ALLOWED_SORT_COLUMNS[sortColKey]) throw new Error(`Invalid sort column: ${sortColKey}`);
  const sortCol = ALLOWED_SORT_COLUMNS[sortColKey] ?? 'c.created_at';
  const rawDir = (filters.sort_dir ?? 'desc').toUpperCase();
  if (rawDir !== 'ASC' && rawDir !== 'DESC') throw new Error('Invalid sort direction');
  const sortDir = rawDir === 'ASC' ? sql`ASC` : sql`DESC`;

  const searchPattern = filters.search ? `%${filters.search}%` : null;

  const [countRow] = await sql`
    SELECT COUNT(DISTINCT c.id) AS total
    FROM companies c
    LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN ('active','trial')
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.status IS DISTINCT FROM 'deleted'
      AND (${searchPattern}::text IS NULL
           OR c.name ILIKE ${searchPattern}
           OR c.registration_number ILIKE ${searchPattern})
      AND (${filters.status ?? null}::text IS NULL OR COALESCE(c.status,'active') = ${filters.status ?? null})
      AND (${filters.plan ?? null}::text IS NULL OR p.code = ${filters.plan ?? null})
  `;

  const rows = await sql`
    SELECT
      c.id,
      c.name,
      c.trading_name,
      COALESCE(c.status, 'active')                                    AS status,
      p.name                                                          AS plan_name,
      p.code                                                          AS plan_code,
      (SELECT COUNT(*) FROM company_users cu WHERE cu.company_id = c.id)::int
                                                                      AS user_count,
      COALESCE(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END, 0
      )::int                                                          AS mrr_cents,
      c.created_at,
      c.updated_at                                                    AS last_active
    FROM companies c
    LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN ('active','trial')
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.status IS DISTINCT FROM 'deleted'
      AND (${searchPattern}::text IS NULL
           OR c.name ILIKE ${searchPattern}
           OR c.registration_number ILIKE ${searchPattern})
      AND (${filters.status ?? null}::text IS NULL OR COALESCE(c.status,'active') = ${filters.status ?? null})
      AND (${filters.plan ?? null}::text IS NULL OR p.code = ${filters.plan ?? null})
    ORDER BY ${sql.unsafe(sortCol)} ${sortDir}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = parseInt((countRow as Row).total as string, 10);

  log.info(`listCompanies: ${rows.length} rows (page ${page}, total ${total})`, {}, 'AdminCompanyService');

  return {
    items: (rows as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      trading_name: r.trading_name as string | null,
      status: r.status as string,
      plan_name: r.plan_name as string | null,
      plan_code: r.plan_code as string | null,
      user_count: r.user_count as number,
      mrr_cents: r.mrr_cents as number,
      created_at: toIso(r.created_at) ?? '',
      last_active: toIso(r.last_active),
    })),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

export async function getCompanyDetail(
  companyId: string
): Promise<AdminCompanyDetail | null> {
  const rows = await sql`
    SELECT
      c.id,
      c.name,
      c.trading_name,
      COALESCE(c.status, 'active')    AS status,
      p.name                          AS plan_name,
      p.code                          AS plan_code,
      c.registration_number,
      c.vat_number,
      c.tax_number,
      c.address_line1,
      c.city,
      c.province,
      c.postal_code,
      c.phone,
      c.email,
      c.website,
      c.billing_email,
      c.billing_contact,
      c.stripe_customer_id,
      c.trial_ends_at,
      c.suspended_at,
      c.suspended_reason,
      c.metadata,
      c.created_at,
      c.updated_at                    AS last_active,
      (SELECT COUNT(*)
         FROM company_users cu
        WHERE cu.company_id = c.id)::int AS user_count,
      COALESCE(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END, 0
      )::int AS mrr_cents
    FROM companies c
    LEFT JOIN subscriptions s ON s.company_id = c.id AND s.status IN ('active','trial')
    LEFT JOIN plans p ON p.id = s.plan_id
    WHERE c.id = ${companyId}
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const r = rows[0] as Row;

  return {
    id: r.id as string,
    name: r.name as string,
    trading_name: r.trading_name as string | null,
    status: r.status as string,
    plan_name: r.plan_name as string | null,
    plan_code: r.plan_code as string | null,
    user_count: r.user_count as number,
    mrr_cents: r.mrr_cents as number,
    created_at: toIso(r.created_at) ?? '',
    last_active: toIso(r.last_active),
    registration_number: r.registration_number as string | null,
    vat_number: r.vat_number as string | null,
    tax_number: r.tax_number as string | null,
    address_line1: r.address_line1 as string | null,
    city: r.city as string | null,
    province: r.province as string | null,
    postal_code: r.postal_code as string | null,
    phone: r.phone as string | null,
    email: r.email as string | null,
    website: r.website as string | null,
    billing_email: r.billing_email as string | null,
    billing_contact: r.billing_contact as string | null,
    stripe_customer_id: r.stripe_customer_id as string | null,
    trial_ends_at: toIso(r.trial_ends_at),
    suspended_at: toIso(r.suspended_at),
    suspended_reason: r.suspended_reason as string | null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  };
}

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

  await sql`
    UPDATE companies SET
      name             = COALESCE(${name ?? null}, name),
      trading_name     = COALESCE(${trading_name ?? null}, trading_name),
      phone            = COALESCE(${phone ?? null}, phone),
      email            = COALESCE(${email ?? null}, email),
      website          = COALESCE(${website ?? null}, website),
      billing_email    = COALESCE(${billing_email ?? null}, billing_email),
      billing_contact  = COALESCE(${billing_contact ?? null}, billing_contact),
      address_line1    = COALESCE(${address_line1 ?? null}, address_line1),
      city             = COALESCE(${city ?? null}, city),
      province         = COALESCE(${province ?? null}, province),
      postal_code      = COALESCE(${postal_code ?? null}, postal_code),
      updated_at       = NOW()
    WHERE id = ${companyId}
  `;

  log.info('updateCompany', { companyId }, 'AdminCompanyService');
}

export async function suspendCompany(
  companyId: string,
  reason: string
): Promise<void> {
  await sql`
    UPDATE companies
    SET status           = 'suspended',
        suspended_reason = ${reason},
        suspended_at     = NOW(),
        updated_at       = NOW()
    WHERE id = ${companyId}
  `;
  log.info('suspendCompany', { companyId, reason }, 'AdminCompanyService');
}

export async function activateCompany(companyId: string): Promise<void> {
  await sql`
    UPDATE companies
    SET status           = 'active',
        suspended_reason = NULL,
        suspended_at     = NULL,
        updated_at       = NOW()
    WHERE id = ${companyId}
  `;
  log.info('activateCompany', { companyId }, 'AdminCompanyService');
}

/** Soft delete — sets status='deleted', preserves data for audit trail. */
export async function deleteCompany(companyId: string): Promise<void> {
  await sql`
    UPDATE companies
    SET status     = 'deleted',
        updated_at = NOW()
    WHERE id = ${companyId}
  `;
  log.info('deleteCompany (soft)', { companyId }, 'AdminCompanyService');
}

export async function getCompanyUsers(
  companyId: string
): Promise<{ id: string; name: string; email: string; role: string; last_login: string | null }[]> {
  const rows = await sql`
    SELECT u.id, COALESCE(u.first_name || ' ' || u.last_name, u.email) AS name, u.email, cu.role, u.last_login
    FROM company_users cu JOIN users u ON u.id = cu.user_id
    WHERE cu.company_id = ${companyId} ORDER BY cu.role, u.email
  `;

  return (rows as Row[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    role: r.role as string,
    last_login: r.last_login != null
      ? (r.last_login instanceof Date ? r.last_login.toISOString() : r.last_login as string)
      : null,
  }));
}
