/**
 * The create wizard's form state and the request it becomes (spec 8). Pure: the steps edit a
 * `WizardDraft`, `stepError` gates Next, and `buildSeedRequest` is exactly what `seedVersion` sends.
 * "Import Excel" creates a blank version (the caller then opens the import dialog).
 */
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { BudgetVersionKind } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import type { SeedRequest } from './budgetWorkspaceClient';
import type { Unassigned } from './seedPreview';

export type SourceChoice = 'py_actuals' | 'version' | 'blank' | 'import';

export interface WizardDraft {
  fiscalYear: number;
  name: string;
  kind: BudgetVersionKind;
  makePrimary: boolean;
  source: SourceChoice;
  /** Text as typed; '' is not a number yet. */
  upliftPct: string;
  /** The year the copy source is picked from (any FY). */
  copyYear: number;
  copyVersionId: string;
  grain: PriorGrain;
  unassigned: Unassigned;
  roundingUnit: RoundingUnit;
  includeNoActivity: boolean;
}

export const MIN_PCT = -100;
export const MAX_PCT = 1000;

export function defaultDraft(o: { fiscalYear: number; hasVersions: boolean; copyVersionId?: string; copyYear?: number }): WizardDraft {
  return {
    fiscalYear: o.fiscalYear, name: '', kind: o.hasVersions ? 'reforecast' : 'original', makePrimary: false,
    source: o.copyVersionId ? 'version' : 'py_actuals', upliftPct: '0',
    copyYear: o.copyYear ?? o.fiscalYear, copyVersionId: o.copyVersionId ?? '',
    grain: 'company', unassigned: 'company', roundingUnit: 1, includeNoActivity: false,
  };
}

/** The uplift as a number, or null when the text is not a number in [-100, 1000]. */
export function parsePct(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '' || !/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_PCT && n <= MAX_PCT ? n : null;
}

/** Why the step cannot be left yet, or null. Steps are 0 Version, 1 Source, 2 Options. */
export function stepError(d: WizardDraft, step: number, firstVersion: boolean): string | null {
  if (step === 0) {
    if (d.name.trim() === '') return 'Give the version a name.';
    if (firstVersion && d.kind !== 'original') return 'The first version of a year is its original budget.';
    return null;
  }
  if (step === 1) {
    if (d.source === 'version' && d.copyVersionId === '') return 'Pick the version to copy.';
    if ((d.source === 'py_actuals' || d.source === 'version') && parsePct(d.upliftPct) === null) {
      return `The uplift must be a number from ${MIN_PCT} to ${MAX_PCT}.`;
    }
  }
  return null;
}

/** The body of POST budget-grid/seed. */
export function buildSeedRequest(d: WizardDraft): SeedRequest {
  const pct = parsePct(d.upliftPct) ?? 0;
  const base = { fiscalYear: d.fiscalYear, name: d.name.trim(), kind: d.kind, makePrimary: d.makePrimary, roundingUnit: d.roundingUnit };
  if (d.source === 'py_actuals') {
    return { ...base, includeNoActivity: d.includeNoActivity, source: { type: 'py_actuals', upliftPct: pct, grain: d.grain, unassigned: d.unassigned } };
  }
  if (d.source === 'version') return { ...base, source: { type: 'version', versionId: d.copyVersionId, upliftPct: pct } };
  return { ...base, source: { type: 'blank' } };
}
