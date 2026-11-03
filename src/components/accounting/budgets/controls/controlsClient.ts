/**
 * The budget controls page's fetchers (budgets P5-4). Each returns an `ApiResult` typed by the route
 * registry (`call`, the budget workspace's): data, or a typed failure the page shows. Nothing here
 * throws on a status or a dropped connection.
 */
import { call } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import type { BudgetAlertList } from '@/modules/accounting/services/budgets/budgetAlertList';
import type { ControlsView, EvaluateNowResult } from '@/modules/accounting/services/budgets/budgetControlsApi';
import type { CheckPolicy, OverrideRow } from '@/modules/accounting/services/budgets/budgetControlSettings';

export type { BudgetAlertList, ControlsView, EvaluateNowResult, CheckPolicy, OverrideRow };

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function fetchControls(): Promise<ApiResult<ControlsView>> {
  return call('/api/accounting/budgets/controls', undefined, 'Could not load the budget controls.');
}

export function saveSettings(patch: { checkPolicy?: CheckPolicy; defaultThresholds?: number[]; alertEmailEnabled?: boolean }): Promise<ApiResult<ControlsView>> {
  return call('/api/accounting/budgets/controls', json('PUT', patch), 'Could not save the budget controls.');
}

export interface OverrideDraft {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  thresholds: number[];
}

export async function saveOverride(draft: OverrideDraft): Promise<ApiResult<OverrideRow>> {
  const r = await call('/api/accounting/budgets/controls/thresholds', json('POST', draft), 'Could not save the override.');
  if (!r.ok) return r;
  return 'override' in r.data ? { ok: true, data: r.data.override } : { ok: false, kind: 'failed', message: 'Could not save the override.', status: 200 };
}

export async function deleteOverride(id: string): Promise<ApiResult<true>> {
  const r = await call('/api/accounting/budgets/controls/thresholds', json('DELETE', { id }), 'Could not remove the override.');
  return r.ok ? { ok: true, data: true } : r;
}

export function fetchAlerts(): Promise<ApiResult<BudgetAlertList>> {
  return call('/api/accounting/budgets/alerts', undefined, 'Could not load the budget alerts.');
}

export function evaluateNow(): Promise<ApiResult<EvaluateNowResult>> {
  return call('/api/accounting/budgets/alerts/evaluate', { method: 'POST' }, 'Could not evaluate the budget alerts.');
}

/** '80, 100, 120' → [80, 100, 120] sorted without duplicates, or a sentence saying what is wrong. */
export function parseThresholds(text: string): { ok: true; values: number[] } | { ok: false; message: string } {
  const parts = text.split(/[,\s]+/).map((p) => p.trim().replace(/%$/, '')).filter(Boolean);
  if (parts.length === 0) return { ok: false, message: 'Enter at least one percentage.' };
  const values = parts.map(Number);
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 999)) return { ok: false, message: 'Each threshold is a whole percentage from 1 to 999.' };
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length > 5) return { ok: false, message: 'At most 5 thresholds.' };
  return { ok: true, values: unique };
}
