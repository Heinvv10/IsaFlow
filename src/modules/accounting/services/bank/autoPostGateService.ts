/**
 * Auto-Post Gate Service
 * Single eligibility authority for silent bank-transaction JE auto-posting.
 * Mirrors the capture-side autoPublishGateService decision-ladder shape.
 *
 * evaluate() is PURE — the primary TDD target. Later tasks append the
 * orchestration and settings logic to this file.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
}

export interface GateTx {
  status: string;
  amount: number;
  suggestedGlAccountId: string | null;
}

export type GateDecision = { outcome: 'post' } | { outcome: 'skip'; reason: string };

// ── Pure gate ────────────────────────────────────────────────────────────────

/**
 * Decision ladder, first failure wins. `confidence === null` is the provisional
 * path: the predictor's score is only known inside postProvisional, so rungs 3
 * (confidence) and 5 (target) defer to it; rungs 1/2/4 still apply up front.
 */
export function evaluate(
  tx: GateTx,
  confidence: number | null,
  settings: AutoPostSettings,
): GateDecision {
  const isProvisionalPath = confidence === null;

  // Rung 1: feature flag
  if (!settings.enabled) return { outcome: 'skip', reason: 'disabled' };

  // Rung 2: tx must be in the 'imported' state
  if (tx.status !== 'imported') return { outcome: 'skip', reason: 'not eligible' };

  // Rung 3: confidence gate (deferred on the provisional path)
  if (!isProvisionalPath && confidence < settings.minConfidence) {
    return { outcome: 'skip', reason: 'confidence too low' };
  }

  // Rung 4: amount cap (0 = uncapped; use absolute value so credits/debits are treated equally)
  if (settings.amountCap > 0 && Math.abs(tx.amount) > settings.amountCap) {
    return { outcome: 'skip', reason: 'over amount cap' };
  }

  // Rung 5: must have a target GL account (deferred on the provisional path)
  if (!isProvisionalPath && tx.suggestedGlAccountId == null) {
    return { outcome: 'skip', reason: 'no target' };
  }

  return { outcome: 'post' };
}

// ── Settings accessors ───────────────────────────────────────────────────────

const DEFAULTS: AutoPostSettings = { enabled: false, minConfidence: 0.9, amountCap: 10000 };

function mapSettings(row: Row): AutoPostSettings {
  return {
    enabled: Boolean(row.enabled),
    minConfidence: Number(row.min_confidence),
    amountCap: Number(row.amount_cap),
  };
}

export async function getAutoPostSettings(companyId: string): Promise<AutoPostSettings> {
  const rows = (await sql`
    SELECT enabled, min_confidence, amount_cap
    FROM bank_auto_post_settings
    WHERE company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  return rows.length === 0 ? { ...DEFAULTS } : mapSettings(rows[0]!);
}

export interface AutoPostSettingsPatch {
  enabled?: boolean;
  minConfidence?: number;
  amountCap?: number;
}

export async function updateAutoPostSettings(
  companyId: string,
  patch: AutoPostSettingsPatch,
  userId: string,
): Promise<AutoPostSettings> {
  if (patch.minConfidence != null && (patch.minConfidence <= 0 || patch.minConfidence > 1)) {
    throw new Error('min_confidence must be within (0, 1]');
  }
  if (patch.amountCap != null && patch.amountCap < 0) {
    throw new Error('amount_cap must be >= 0');
  }

  const enabled = patch.enabled ?? null;
  const minConfidence = patch.minConfidence ?? null;
  const amountCap = patch.amountCap ?? null;

  const rows = (await sql`
    INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap, updated_by, updated_at)
    VALUES (
      ${companyId}::UUID,
      COALESCE(${enabled}, FALSE),
      COALESCE(${minConfidence}::NUMERIC, 0.90),
      COALESCE(${amountCap}::NUMERIC, 10000),
      ${userId}::UUID,
      NOW()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      enabled        = COALESCE(${enabled}, bank_auto_post_settings.enabled),
      min_confidence = COALESCE(${minConfidence}::NUMERIC, bank_auto_post_settings.min_confidence),
      amount_cap     = COALESCE(${amountCap}::NUMERIC, bank_auto_post_settings.amount_cap),
      updated_by     = ${userId}::UUID,
      updated_at     = NOW()
    RETURNING enabled, min_confidence, amount_cap
  `) as Row[];

  log.info('Updated auto-post settings', { companyId, patch }, 'auto-post-gate');
  return mapSettings(rows[0]!);
}
