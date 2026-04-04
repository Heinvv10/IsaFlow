/**
 * Plan Service
 * CRUD operations for billing plans in the ISAFlow Admin Platform.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { Plan } from '../types/admin.types';
type Row = Record<string, unknown>;


function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

function rowToPlan(r: Row): Plan {
  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    description: r.description as string | null,
    monthly_price_cents: r.monthly_price_cents as number,
    annual_price_cents: r.annual_price_cents as number,
    currency: r.currency as string,
    features: (r.features ?? {}) as Record<string, unknown>,
    limits: (r.limits ?? {}) as Record<string, unknown>,
    is_active: r.is_active as boolean,
    display_order: r.display_order as number,
    created_at: toIso(r.created_at),
    updated_at: toIso(r.updated_at),
  };
}

export async function listPlans(includeArchived = false): Promise<Plan[]> {
  const rows = includeArchived
    ? await sql`
        SELECT * FROM plans
        ORDER BY display_order ASC, name ASC
      `
    : await sql`
        SELECT * FROM plans
        WHERE is_active = true
        ORDER BY display_order ASC, name ASC
      `;

  log.info(`listPlans: ${rows.length} plans (includeArchived=${includeArchived})`, {}, 'PlanService');
  return (rows as Row[]).map(rowToPlan);
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const rows = await sql`
    SELECT * FROM plans
    WHERE id = ${planId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rowToPlan(rows[0] as Row);
}

export interface CreatePlanData {
  code: string;
  name: string;
  description?: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  currency?: string;
  features?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  display_order?: number;
}

export async function createPlan(data: CreatePlanData): Promise<Plan> {
  const {
    code,
    name,
    description = null,
    monthly_price_cents,
    annual_price_cents,
    currency = 'ZAR',
    features = {},
    limits = {},
    display_order = 0,
  } = data;

  const rows = await sql`
    INSERT INTO plans (
      code, name, description,
      monthly_price_cents, annual_price_cents, currency,
      features, limits, is_active, display_order,
      created_at, updated_at
    ) VALUES (
      ${code}, ${name}, ${description},
      ${monthly_price_cents}, ${annual_price_cents}, ${currency},
      ${JSON.stringify(features)}::jsonb, ${JSON.stringify(limits)}::jsonb,
      true, ${display_order},
      NOW(), NOW()
    )
    RETURNING *
  `;

  const plan = rowToPlan(rows[0] as Row);
  log.info('createPlan', { planId: plan.id, code }, 'PlanService');
  return plan;
}

export async function updatePlan(
  planId: string,
  data: Partial<Plan>
): Promise<void> {
  const {
    name, description, monthly_price_cents, annual_price_cents,
    currency, features, limits, is_active, display_order,
  } = data;

  await sql`
    UPDATE plans SET
      name                 = COALESCE(${name ?? null}, name),
      description          = COALESCE(${description ?? null}, description),
      monthly_price_cents  = COALESCE(${monthly_price_cents ?? null}, monthly_price_cents),
      annual_price_cents   = COALESCE(${annual_price_cents ?? null}, annual_price_cents),
      currency             = COALESCE(${currency ?? null}, currency),
      features             = COALESCE(${features != null ? JSON.stringify(features) : null}::jsonb, features),
      limits               = COALESCE(${limits != null ? JSON.stringify(limits) : null}::jsonb, limits),
      is_active            = COALESCE(${is_active ?? null}, is_active),
      display_order        = COALESCE(${display_order ?? null}, display_order),
      updated_at           = NOW()
    WHERE id = ${planId}
  `;

  log.info('updatePlan', { planId, fields: Object.keys(data) }, 'PlanService');
}

export async function archivePlan(planId: string): Promise<void> {
  await sql`
    UPDATE plans
    SET is_active  = false,
        updated_at = NOW()
    WHERE id = ${planId}
  `;
  log.info('archivePlan', { planId }, 'PlanService');
}
