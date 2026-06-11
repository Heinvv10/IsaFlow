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
import { allocateTransaction } from './bankAllocationService';
import { postProvisional } from '../capture/provisionalPostingService';

type Row = DbRow;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number; // 0 = uncapped
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number; // 0 = uncapped
}

export interface GateTx {
  status: string;
  amount: number;
  suggestedGlAccountId: string | null;
}

export type GateDecision = { outcome: 'post' } | { outcome: 'skip'; reason: string };

export type AutoPostSource = 'import' | 'categorization' | 'manual';

export interface SweepResult {
  runId: string | null;
  posted: number;
  skipped: Array<{ txId: string; reason: string }>;
}

export const AUTO_POST_AGENT = 'ai:auto-post:v1';

// ── Pure gate ────────────────────────────────────────────────────────────────

/**
 * Decision ladder, first failure wins. The status check (rung 2) now runs
 * BEFORE any feature-flag check so it always applies to both tiers.
 *
 * `strategy === 'llm'` routes through the fully-separate LLM tier: the
 * standard enabled/minConfidence/amountCap settings have NO effect here.
 * The LLM tier only posts when `llmEnabled && confidence >= llmMinConfidence
 * && within llmAmountCap`.
 *
 * `confidence === null` is the provisional path (source='import'): the
 * predictor's score is only known inside postProvisional, so rungs 3
 * (confidence) and 5 (target) defer to it; rung 2 and the amount cap
 * still apply up front.
 */
export function evaluate(
  tx: GateTx,
  confidence: number | null,
  settings: AutoPostSettings,
  strategy: string | null,
): GateDecision {
  const isProvisionalPath = confidence === null;
  const isLlm = strategy === 'llm';

  // Rung 2 always applies: tx must be in the 'imported' state.
  if (tx.status !== 'imported') return { outcome: 'skip', reason: 'not eligible' };

  if (isLlm) {
    // LLM tier — fully separate from the standard gate.
    if (!settings.llmEnabled) return { outcome: 'skip', reason: 'llm disabled' };
    if (confidence == null || confidence < settings.llmMinConfidence) {
      return { outcome: 'skip', reason: 'llm confidence too low' };
    }
    if (settings.llmAmountCap > 0 && Math.abs(tx.amount) > settings.llmAmountCap) {
      return { outcome: 'skip', reason: 'llm over amount cap' };
    }
    if (tx.suggestedGlAccountId == null) return { outcome: 'skip', reason: 'no target' };
    return { outcome: 'post' };
  }

  // Standard tier (rules/patterns/history, or provisional import path).
  if (!settings.enabled) return { outcome: 'skip', reason: 'disabled' };
  if (!isProvisionalPath && confidence < settings.minConfidence) {
    return { outcome: 'skip', reason: 'confidence too low' };
  }
  if (settings.amountCap > 0 && Math.abs(tx.amount) > settings.amountCap) {
    return { outcome: 'skip', reason: 'over amount cap' };
  }
  if (!isProvisionalPath && tx.suggestedGlAccountId == null) {
    return { outcome: 'skip', reason: 'no target' };
  }
  return { outcome: 'post' };
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

// ── Settings accessors ───────────────────────────────────────────────────────

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

// ── Sweep ────────────────────────────────────────────────────────────────────

interface SweepRow {
  id: string;
  status: string;
  amount: string | number;
  suggested_gl_account_id: string | null;
  suggested_confidence: string | number | null;
  suggested_vat_code: string | null;
  suggested_strategy: string | null;
  description: string | null;
}

/**
 * Evaluate the given txs and post the eligible ones through the existing
 * plumbing. source 'import' uses the provisional predictor path; everything
 * else uses the suggestion (allocate) path. The run row is created lazily on
 * the first successful post — a sweep that posts nothing leaves no run row.
 */
export async function sweep(
  companyId: string,
  txIds: string[],
  source: AutoPostSource,
  userId: string,
): Promise<SweepResult> {
  const settings = await getAutoPostSettings(companyId);
  if ((!settings.enabled && !settings.llmEnabled) || txIds.length === 0) {
    return { runId: null, posted: 0, skipped: [] };
  }

  const rows = (await sql`
    SELECT id, status, amount, suggested_gl_account_id, suggested_confidence,
           suggested_vat_code, suggested_strategy, description
    FROM bank_transactions
    WHERE id = ANY(${txIds}::UUID[]) AND company_id = ${companyId}::UUID
  `) as unknown as SweepRow[];

  const skipped: Array<{ txId: string; reason: string }> = [];
  let runId: string | null = null;
  let posted = 0;
  let totalAmount = 0;

  async function ensureRun(strategy: string | null): Promise<string> {
    if (runId) return runId;
    const snap = autoPostRunSnapshot(strategy, settings);
    const r = (await sql`
      INSERT INTO bank_auto_post_runs (company_id, source, min_confidence, amount_cap, created_by)
      VALUES (${companyId}::UUID, ${source}, ${snap.minConfidence}::NUMERIC,
              ${snap.amountCap}::NUMERIC, ${userId}::UUID)
      RETURNING id
    `) as Row[];
    runId = String(r[0]!.id);
    return runId;
  }

  const isImport = source === 'import';

  for (const row of rows) {
    const confidence = isImport
      ? null
      : (row.suggested_confidence != null ? Number(row.suggested_confidence) : null);

    const decision = evaluate(
      { status: row.status, amount: Number(row.amount), suggestedGlAccountId: row.suggested_gl_account_id },
      confidence,
      settings,
      isImport ? null : (row.suggested_strategy ?? null),
    );
    if (decision.outcome === 'skip') {
      skipped.push({ txId: row.id, reason: decision.reason });
      continue;
    }

    let jePosted = false;
    try {
      if (isImport) {
        const res = await postProvisional(companyId, row.id, userId, { minConfidence: settings.minConfidence });
        if (!res.journalEntryId) {
          skipped.push({ txId: row.id, reason: res.skipped ?? 'no target' });
          continue;
        }
        jePosted = true;
      } else {
        await allocateTransaction(
          companyId, row.id, row.suggested_gl_account_id, userId,
          row.description ?? undefined, 'account', undefined,
          row.suggested_vat_code ?? undefined,
          undefined, undefined, undefined, undefined,
          { postingAgent: AUTO_POST_AGENT },
        );
        jePosted = true;
      }
      const id = await ensureRun(isImport ? null : (row.suggested_strategy ?? null));
      await sql`
        UPDATE bank_transactions SET auto_post_run_id = ${id}::UUID
        WHERE id = ${row.id}::UUID AND company_id = ${companyId}::UUID
      `;
      posted += 1;
      totalAmount += Math.abs(Number(row.amount));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (jePosted) {
        log.error('Auto-post JE posted but run-tag failed — JE orphaned (needs manual reconciliation)', { companyId, txId: row.id, reason }, 'auto-post-gate');
      } else {
        log.warn('Auto-post failed for bank transaction — skipping', { companyId, txId: row.id, reason }, 'auto-post-gate');
      }
      skipped.push({ txId: row.id, reason });
    }
  }

  if (runId) {
    await sql`
      UPDATE bank_auto_post_runs
      SET posted_count = ${posted}, total_amount = ${totalAmount}::NUMERIC
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  log.info('Auto-post sweep complete', { companyId, source, posted, skipped: skipped.length, runId }, 'auto-post-gate');
  return { runId, posted, skipped };
}
