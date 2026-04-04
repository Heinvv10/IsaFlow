/**
 * Feature Flag Service
 * Resolves effective features per company based on global flags, plan features,
 * and company-level overrides. Used by both the admin platform and feature gating middleware.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  FeatureFlag,
  CompanyEffectiveFeature,
} from '../types/admin.types';

type Row = Record<string, unknown>;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const rows = await sql`
    SELECT id, code, name, description, is_global, created_at
    FROM feature_flags
    ORDER BY code ASC
  `;

  log.info(`listFeatureFlags: ${rows.length} flags`, {}, 'FeatureFlagService');

  return (rows as Row[]).map((r) => ({
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    description: r.description as string | null,
    is_global: r.is_global as boolean,
    created_at: toIso(r.created_at),
  }));
}

export async function getFeatureFlag(id: string): Promise<FeatureFlag | null> {
  const rows = await sql`
    SELECT id, code, name, description, is_global, created_at
    FROM feature_flags
    WHERE id = ${id}
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const r = rows[0] as Row;

  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    description: r.description as string | null,
    is_global: r.is_global as boolean,
    created_at: toIso(r.created_at),
  };
}

export async function updateFeatureFlag(
  id: string,
  data: { name?: string; description?: string; is_global?: boolean }
): Promise<void> {
  await sql`
    UPDATE feature_flags
    SET
      name        = COALESCE(${data.name ?? null}, name),
      description = COALESCE(${data.description ?? null}, description),
      is_global   = COALESCE(${data.is_global ?? null}, is_global)
    WHERE id = ${id}
  `;

  log.info('updateFeatureFlag', { id, data }, 'FeatureFlagService');
}

export async function getCompanyEffectiveFeatures(
  companyId: string
): Promise<CompanyEffectiveFeature[]> {
  // Fetch all flags, plan memberships and overrides in parallel
  const [flagRows, planRows, overrideRows] = await Promise.all([
    sql`
      SELECT id, code, name, is_global
      FROM feature_flags
      ORDER BY code ASC
    `,
    sql`
      SELECT pf.feature_id
      FROM plan_features pf
      JOIN companies c ON c.plan_id = pf.plan_id
      WHERE c.id = ${companyId}
    `,
    sql`
      SELECT feature_id, enabled
      FROM company_feature_overrides
      WHERE company_id = ${companyId}
    `,
  ]);

  const planFeatureIds = new Set(
    (planRows as Row[]).map((r) => r.feature_id as string)
  );

  const overrideMap = new Map<string, boolean>(
    (overrideRows as Row[]).map((r) => [r.feature_id as string, r.enabled as boolean])
  );

  return (flagRows as Row[]).map((r) => {
    const id = r.id as string;
    const isGlobal = r.is_global as boolean;
    const inPlan = planFeatureIds.has(id);
    const override = overrideMap.get(id);

    let enabled: boolean;
    let source: 'global' | 'plan' | 'override';

    if (override !== undefined) {
      // Override always wins
      enabled = override;
      source = 'override';
    } else if (isGlobal) {
      enabled = true;
      source = 'global';
    } else if (inPlan) {
      enabled = true;
      source = 'plan';
    } else {
      enabled = false;
      source = 'plan';
    }

    return {
      code: r.code as string,
      name: r.name as string,
      enabled,
      source,
    };
  });
}

export async function setCompanyFeatureOverride(
  companyId: string,
  featureId: string,
  enabled: boolean,
  reason: string,
  setBy: string
): Promise<void> {
  await sql`
    INSERT INTO company_feature_overrides
      (company_id, feature_id, enabled, reason, set_by, created_at)
    VALUES
      (${companyId}, ${featureId}, ${enabled}, ${reason}, ${setBy}, NOW())
    ON CONFLICT (company_id, feature_id)
    DO UPDATE SET
      enabled    = EXCLUDED.enabled,
      reason     = EXCLUDED.reason,
      set_by     = EXCLUDED.set_by,
      created_at = NOW()
  `;

  log.info('setCompanyFeatureOverride', { companyId, featureId, enabled }, 'FeatureFlagService');
}

export async function removeCompanyFeatureOverride(
  companyId: string,
  featureId: string
): Promise<void> {
  await sql`
    DELETE FROM company_feature_overrides
    WHERE company_id = ${companyId}
      AND feature_id = ${featureId}
  `;

  log.info('removeCompanyFeatureOverride', { companyId, featureId }, 'FeatureFlagService');
}

export async function hasFeature(
  companyId: string,
  featureCode: string
): Promise<boolean> {
  const rows = await sql`
    SELECT
      ff.is_global,
      EXISTS (
        SELECT 1
        FROM plan_features pf
        JOIN companies c ON c.plan_id = pf.plan_id
        WHERE c.id = ${companyId}
          AND pf.feature_id = ff.id
      ) AS in_plan,
      cfo.enabled AS override_enabled
    FROM feature_flags ff
    LEFT JOIN company_feature_overrides cfo
      ON cfo.feature_id = ff.id
      AND cfo.company_id = ${companyId}
    WHERE ff.code = ${featureCode}
    LIMIT 1
  `;

  if (rows.length === 0) return false;

  const r = rows[0] as Row;
  const overrideEnabled = r.override_enabled as boolean | null;

  // Override takes precedence
  if (overrideEnabled !== null) return overrideEnabled;
  // Then global flag
  if (r.is_global as boolean) return true;
  // Then plan membership
  return r.in_plan as boolean;
}
