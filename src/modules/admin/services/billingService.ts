/**
 * Billing Service — Overview & Subscriptions
 * Aggregate KPIs and subscription lifecycle for the ISAFlow Admin Platform.
 * Invoice operations are in invoiceService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  BillingOverview,
  SubscriptionListItem,
  PaginatedResult,
} from '../types/admin.types';

type Row = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getBillingOverview(): Promise<BillingOverview> {
  const [[subRow], [churnRow], [revRow]] = await Promise.all([
    sql`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE s.status = 'active')   AS active,
        COUNT(*) FILTER (WHERE s.status = 'past_due') AS past_due,
        COUNT(*) FILTER (WHERE s.status = 'trial')    AS trial,
        COALESCE(SUM(CASE
          WHEN s.status != 'active' THEN 0
          WHEN s.billing_cycle = 'monthly' THEN ROUND(p.monthly_price_cents::numeric * (100 - COALESCE(s.discount_percent, 0)::numeric) / 100.0)
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents::numeric * (100 - COALESCE(s.discount_percent, 0)::numeric) / 1200.0)
          ELSE 0 END), 0) AS mrr_cents
      FROM subscriptions s INNER JOIN plans p ON p.id = s.plan_id
    `,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'cancelled'
          AND cancelled_at >= NOW() - INTERVAL '30 days')::float AS cancelled_30d,
        GREATEST(COUNT(*) FILTER (WHERE status IN ('active','trial','past_due')
          OR (status = 'cancelled' AND cancelled_at >= NOW() - INTERVAL '30 days')), 1)::float AS base
      FROM subscriptions
    `,
    sql`
      SELECT
        COALESCE(SUM(total_cents) FILTER (WHERE status = 'paid'), 0)              AS total_revenue_cents,
        COALESCE(SUM(total_cents) FILTER (WHERE status IN ('sent','overdue')), 0)  AS outstanding_cents
      FROM admin_invoices
    `,
  ]);

  const s = subRow as Row;
  const c = churnRow as Row;
  const rv = revRow as Row;
  const mrr = parseInt(s.mrr_cents as string, 10);
  const active = parseInt(s.active as string, 10);
  const churnRate = Math.round(((c.cancelled_30d as number) / (c.base as number)) * 10000) / 100;

  const overview: BillingOverview = {
    mrr_cents: mrr,
    arr_cents: mrr * 12,
    total_subscriptions: parseInt(s.total as string, 10),
    active_subscriptions: active,
    past_due_count: parseInt(s.past_due as string, 10),
    trial_count: parseInt(s.trial as string, 10),
    churn_rate_percent: churnRate,
    arpu_cents: active > 0 ? Math.round(mrr / active) : 0,
    total_revenue_cents: parseInt(rv.total_revenue_cents as string, 10),
    outstanding_cents: parseInt(rv.outstanding_cents as string, 10),
  };

  log.info('getBillingOverview', { mrr_cents: mrr, active }, 'BillingService');
  return overview;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

const ALLOWED_SUB_SORT: Record<string, string> = {
  created_at: 's.created_at',
  status: 's.status',
  company_name: 'c.name',
  plan_name: 'p.name',
};

function rowToSubscription(r: Row): SubscriptionListItem {
  return {
    id: r.id as string,
    company_id: r.company_id as string,
    company_name: r.company_name as string,
    plan_id: r.plan_id as string,
    plan_name: r.plan_name as string,
    plan_code: r.plan_code as string,
    status: r.status as string,
    billing_cycle: r.billing_cycle as string,
    current_period_start: toIso(r.current_period_start),
    current_period_end: toIso(r.current_period_end),
    cancel_at_period_end: r.cancel_at_period_end as boolean,
    discount_percent: r.discount_percent as number,
    monthly_amount_cents: parseInt(r.monthly_amount_cents as string, 10),
    created_at: toIso(r.created_at) ?? '',
  };
}

export async function listSubscriptions(filters: {
  status?: string;
  plan_id?: string;
  search?: string;
  page?: number;
  limit?: number;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}): Promise<PaginatedResult<SubscriptionListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;
  const sortColKey = filters.sort_by ?? '';
  if (sortColKey && !ALLOWED_SUB_SORT[sortColKey]) throw new Error(`Invalid sort column: ${sortColKey}`);
  const sortCol = ALLOWED_SUB_SORT[sortColKey] ?? 's.created_at';
  const rawDir = (filters.sort_dir ?? 'desc').toUpperCase();
  if (rawDir !== 'ASC' && rawDir !== 'DESC') throw new Error('Invalid sort direction');
  const sortDir = rawDir === 'ASC' ? sql`ASC` : sql`DESC`;
  const search = filters.search ? `%${filters.search}%` : null;

  const [countRow] = await sql`
    SELECT COUNT(*) AS total
    FROM subscriptions s
    INNER JOIN companies c ON c.id = s.company_id
    INNER JOIN plans p ON p.id = s.plan_id
    WHERE (${filters.status ?? null}::text IS NULL OR s.status = ${filters.status ?? null})
      AND (${filters.plan_id ?? null}::uuid IS NULL OR s.plan_id = ${filters.plan_id ?? null}::uuid)
      AND (${search}::text IS NULL OR c.name ILIKE ${search})
  `;

  const rows = await sql`
    SELECT s.id, s.company_id, c.name AS company_name,
      s.plan_id, p.name AS plan_name, p.code AS plan_code,
      s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
      COALESCE(s.cancel_at_period_end, false) AS cancel_at_period_end,
      COALESCE(s.discount_percent, 0)          AS discount_percent,
      CASE WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
           WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
           ELSE 0 END AS monthly_amount_cents, s.created_at
    FROM subscriptions s
    INNER JOIN companies c ON c.id = s.company_id
    INNER JOIN plans p ON p.id = s.plan_id
    WHERE (${filters.status ?? null}::text IS NULL OR s.status = ${filters.status ?? null})
      AND (${filters.plan_id ?? null}::uuid IS NULL OR s.plan_id = ${filters.plan_id ?? null}::uuid)
      AND (${search}::text IS NULL OR c.name ILIKE ${search})
    ORDER BY ${sql.unsafe(sortCol)} ${sortDir}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = parseInt((countRow as Row).total as string, 10);
  log.info(`listSubscriptions: ${rows.length} rows (page ${page})`, {}, 'BillingService');

  return {
    items: (rows as Row[]).map(rowToSubscription),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

export async function getSubscription(
  subscriptionId: string
): Promise<SubscriptionListItem | null> {
  const rows = await sql`
    SELECT s.id, s.company_id, c.name AS company_name,
      s.plan_id, p.name AS plan_name, p.code AS plan_code,
      s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
      COALESCE(s.cancel_at_period_end, false) AS cancel_at_period_end,
      COALESCE(s.discount_percent, 0)          AS discount_percent,
      CASE WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
           WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
           ELSE 0 END AS monthly_amount_cents, s.created_at
    FROM subscriptions s
    INNER JOIN companies c ON c.id = s.company_id
    INNER JOIN plans p ON p.id = s.plan_id
    WHERE s.id = ${subscriptionId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToSubscription(rows[0] as Row);
}

export async function createSubscription(data: {
  company_id: string;
  plan_id: string;
  billing_cycle: string;
  discount_percent?: number;
  notes?: string;
}): Promise<string> {
  const { company_id, plan_id, billing_cycle, discount_percent = 0, notes = null } = data;
  const periodDays = billing_cycle === 'annual' ? 365 : 30;

  const rows = await sql`
    INSERT INTO subscriptions (
      company_id, plan_id, status, billing_cycle,
      current_period_start, current_period_end,
      cancel_at_period_end, discount_percent, notes,
      created_at, updated_at
    ) VALUES (
      ${company_id}::uuid, ${plan_id}::uuid,
      'active', ${billing_cycle},
      NOW(), NOW() + INTERVAL '1 day' * ${periodDays},
      false, ${discount_percent}, ${notes},
      NOW(), NOW()
    )
    RETURNING id
  `;

  const id = (rows[0] as Row).id as string;
  log.info('createSubscription', { id, company_id, plan_id, billing_cycle }, 'BillingService');
  return id;
}

const ALLOWED_STATUSES = ['active', 'trial', 'past_due', 'cancelled', 'suspended'];

export async function updateSubscription(
  subscriptionId: string,
  data: {
    plan_id?: string;
    billing_cycle?: string;
    discount_percent?: number;
    status?: string;
    notes?: string;
  }
): Promise<void> {
  const { plan_id, billing_cycle, discount_percent, status, notes } = data;
  if (status && !ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid subscription status: ${status}`);
  }

  await sql`
    UPDATE subscriptions SET
      plan_id          = COALESCE(${plan_id ?? null}::uuid, plan_id),
      billing_cycle    = COALESCE(${billing_cycle ?? null}, billing_cycle),
      discount_percent = COALESCE(${discount_percent ?? null}, discount_percent),
      status           = COALESCE(${status ?? null}, status),
      notes            = COALESCE(${notes ?? null}, notes),
      updated_at       = NOW()
    WHERE id = ${subscriptionId}
  `;

  log.info('updateSubscription', { subscriptionId }, 'BillingService');
}

export async function cancelSubscription(
  subscriptionId: string,
  atPeriodEnd: boolean
): Promise<void> {
  if (atPeriodEnd) {
    await sql`
      UPDATE subscriptions
      SET cancel_at_period_end = true,
          updated_at           = NOW()
      WHERE id = ${subscriptionId}
    `;
  } else {
    await sql`
      UPDATE subscriptions
      SET status       = 'cancelled',
          cancelled_at = NOW(),
          updated_at   = NOW()
      WHERE id = ${subscriptionId}
    `;
  }
  log.info('cancelSubscription', { subscriptionId, atPeriodEnd }, 'BillingService');
}
