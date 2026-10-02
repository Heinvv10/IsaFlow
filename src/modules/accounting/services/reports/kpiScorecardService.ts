/**
 * KPI Scorecard Service — traffic-light scoring of financial KPIs.
 * Pure business logic — no database dependencies.
 */

import type { ExtendedRatioResult } from './reportingEngineService';
import { ratioLabel } from './ratioPresentation';

/** The ratios a scorecard is built from: the engine's result, in which any
 *  ratio may be null with its reason in `notMeaningful`. */
export type ScorableRatios = ExtendedRatioResult;

export interface KPITargetConfig {
  ratioKey: string;
  target: number;
  warningThreshold: number;
  criticalThreshold: number;
  lowerIsBetter: boolean;
}

export interface KPIScorecardItem {
  ratioKey: string;
  name: string;
  /** null when the ratio could not be computed — see `reason`. */
  value: number | null;
  target: number;
  status: 'green' | 'amber' | 'red' | 'not_meaningful';
  /** Why the ratio could not be scored. Present only when status is not_meaningful. */
  reason?: string;
  percentOfTarget: number;
}

/**
 * Build a KPI scorecard from ratio results and target configuration.
 */
export function buildKPIScorecard(
  ratios: ScorableRatios,
  targets: KPITargetConfig[],
): KPIScorecardItem[] {
  return targets.map(config => {
    const value = (ratios as unknown as Record<string, unknown>)[config.ratioKey];
    // A ratio the engine could not compute is null, and coercing that to 0 is
    // how AN-07 scored an insolvent company green: debt-to-equity is
    // lowerIsBetter, so 0 beat every target. Report it as unscored instead.
    const reason = ratios.notMeaningful?.[config.ratioKey];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ratioKey: config.ratioKey,
        name: ratioLabel(config.ratioKey),
        value: null,
        target: config.target,
        percentOfTarget: 0,
        status: 'not_meaningful' as const,
        reason: reason ?? 'This ratio could not be computed from the available figures.',
      };
    }
    const numValue = value;

    const percentOfTarget = config.target !== 0
      ? Math.round((numValue / config.target) * 10000) / 100
      : 0;

    const status = scoreStatus(numValue, config);

    return {
      ratioKey: config.ratioKey,
      name: ratioLabel(config.ratioKey),
      value: numValue,
      target: config.target,
      status,
      percentOfTarget,
    };
  });
}

function scoreStatus(
  value: number,
  config: KPITargetConfig,
): 'green' | 'amber' | 'red' {
  if (config.lowerIsBetter) {
    // Lower is better: below target = green, above warning = amber, above critical = red
    if (value <= config.target) return 'green';
    if (value <= config.warningThreshold) return 'amber';
    return 'red';
  }

  // Higher is better: above target = green, above warning = amber, below critical = red
  if (value >= config.target) return 'green';
  if (value >= config.warningThreshold) return 'amber';
  return 'red';
}
