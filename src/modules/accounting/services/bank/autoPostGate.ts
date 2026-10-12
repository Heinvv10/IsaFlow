/**
 * Auto-Post Gate — the pure half of `autoPostGateService`: the eligibility
 * decision ladder and the types the sweep trades in. Split out so the service
 * stays under the repo's 300-line ceiling; `autoPostGateService` re-exports
 * everything here because every caller has always imported it from there.
 *
 * evaluate() is PURE — the primary TDD target.
 */

import type { AutoPostSettings } from './autoPostSettingsService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GateTx {
  status: string;
  amount: number;
  suggestedGlAccountId: string | null;
}

export type GateDecision = { outcome: 'post' } | { outcome: 'skip'; reason: string };

export type AutoPostSource = 'import' | 'categorization' | 'manual';

/** One posted bank transaction whose journal dropped a pick: the sentences `postProvisional` returned for it. */
export interface SweepWarning {
  txId: string;
  journalEntryId: string;
  warnings: string[];
}

export interface SweepResult {
  runId: string | null;
  posted: number;
  skipped: Array<{ txId: string; reason: string }>;
  /** Lines posted gross because s17(2)(a) denied the input tax. */
  vatDenied?: number;
  /** Lines posted gross because no supply can arise on the account. */
  nonSupplyCoerced?: number;
  /**
   * Cost-centre picks a posting could not apply (gl/dimensions/costCentrePick),
   * per bank transaction. The line posted without the centre; this is how the
   * person who ran the sweep learns it. Empty when nothing was dropped.
   */
  warnings: SweepWarning[];
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
