/**
 * Auto-Post Gate Service
 * Single eligibility authority for silent bank-transaction JE auto-posting.
 * Mirrors the capture-side autoPublishGateService decision-ladder shape.
 *
 * evaluate() is PURE — the primary TDD target. Later tasks append the
 * orchestration and settings logic to this file.
 */

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
