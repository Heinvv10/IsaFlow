/**
 * Auto-Post Settings — the per-company (min_confidence, amount_cap) pairs the
 * gate reads before it posts anything.
 *
 * Split out of `autoPostGateService` so that file stays under the 300-line
 * ceiling; the gate re-exports everything here, so no call site moved.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number; // 0 = uncapped
}

const DEFAULTS: AutoPostSettings = {
  enabled: false, minConfidence: 0.9, amountCap: 10000,
  llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000,
};

function mapSettings(row: Row): AutoPostSettings {
  return {
    enabled: Boolean(row.enabled),
    minConfidence: Number(row.min_confidence),
    amountCap: Number(row.amount_cap),
    llmEnabled: Boolean(row.llm_enabled),
    llmMinConfidence: Number(row.llm_min_confidence),
    llmAmountCap: Number(row.llm_amount_cap),
  };
}

export async function getAutoPostSettings(companyId: string): Promise<AutoPostSettings> {
  const rows = (await sql`
    SELECT enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
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
  llmEnabled?: boolean;
  llmMinConfidence?: number;
  llmAmountCap?: number;
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
  if (patch.llmMinConfidence != null && (patch.llmMinConfidence <= 0 || patch.llmMinConfidence > 1)) {
    throw new Error('llm_min_confidence must be within (0, 1]');
  }
  if (patch.llmAmountCap != null && patch.llmAmountCap < 0) {
    throw new Error('llm_amount_cap must be >= 0');
  }

  const enabled = patch.enabled ?? null;
  const minConfidence = patch.minConfidence ?? null;
  const amountCap = patch.amountCap ?? null;
  const llmEnabled = patch.llmEnabled ?? null;
  const llmMinConfidence = patch.llmMinConfidence ?? null;
  const llmAmountCap = patch.llmAmountCap ?? null;

  const rows = (await sql`
    INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_by, updated_at)
    VALUES (
      ${companyId}::UUID,
      COALESCE(${enabled}, FALSE),
      COALESCE(${minConfidence}::NUMERIC, 0.90),
      COALESCE(${amountCap}::NUMERIC, 10000),
      COALESCE(${llmEnabled}, FALSE),
      COALESCE(${llmMinConfidence}::NUMERIC, 0.95),
      COALESCE(${llmAmountCap}::NUMERIC, 2000),
      ${userId}::UUID,
      NOW()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      enabled            = COALESCE(${enabled}, bank_auto_post_settings.enabled),
      min_confidence     = COALESCE(${minConfidence}::NUMERIC, bank_auto_post_settings.min_confidence),
      amount_cap         = COALESCE(${amountCap}::NUMERIC, bank_auto_post_settings.amount_cap),
      llm_enabled        = COALESCE(${llmEnabled}, bank_auto_post_settings.llm_enabled),
      llm_min_confidence = COALESCE(${llmMinConfidence}::NUMERIC, bank_auto_post_settings.llm_min_confidence),
      llm_amount_cap     = COALESCE(${llmAmountCap}::NUMERIC, bank_auto_post_settings.llm_amount_cap),
      updated_by         = ${userId}::UUID,
      updated_at         = NOW()
    RETURNING enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap
  `) as Row[];

  log.info('Updated auto-post settings', { companyId, patch }, 'auto-post-gate');
  return mapSettings(rows[0]!);
}

/**
 * The (min_confidence, amount_cap) pair to record on a bank_auto_post_runs row,
 * chosen by the posting strategy. An 'llm' post is gated by the LLM pair; every
 * other strategy (and the provisional import path) uses the standard pair.
 * NOTE: a run row is created lazily on the first post, so for a (rare) mixed-
 * strategy sweep the snapshot reflects the FIRST posted row's tier.
 */
export function autoPostRunSnapshot(
  strategy: string | null,
  settings: AutoPostSettings,
): { minConfidence: number; amountCap: number } {
  return strategy === 'llm'
    ? { minConfidence: settings.llmMinConfidence, amountCap: settings.llmAmountCap }
    : { minConfidence: settings.minConfidence, amountCap: settings.amountCap };
}
