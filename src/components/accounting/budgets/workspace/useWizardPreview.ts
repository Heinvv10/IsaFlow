/**
 * Loads what the wizard's preview needs (prior-year actuals, and the copy source's cells) and
 * computes the figures with `seedPreview`. Stale responses are dropped: only the latest inputs win.
 */
import { useEffect, useMemo, useState } from 'react';
import { fromCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';
import { fetchGridCells, fetchPriorActuals } from './budgetWorkspaceClient';
import { priorFigures, pySeedFigures, versionSeedFigures, type PreviewAccount, type PreviewFigures, type PreviewResult } from './seedPreview';
import { parsePct, type WizardDraft } from './wizardDraft';

export interface WizardPreview {
  loading: boolean;
  error: string | null;
  /** Rand per metric; null while unknown. */
  prior: PreviewFigures | null;
  next: PreviewResult | null;
}

const toRand = (f: PreviewFigures): PreviewFigures => ({ turnover: fromCents(f.turnover), grossProfit: fromCents(f.grossProfit), netProfit: fromCents(f.netProfit) });

export function useWizardPreview(draft: WizardDraft, years: readonly BudgetYear[], accounts: readonly PreviewAccount[], enabled: boolean): WizardPreview {
  const grain = draft.source === 'py_actuals' ? draft.grain : 'company';
  const [prior, setPrior] = useState<{ key: string; data: PriorActuals } | null>(null);
  const [copy, setCopy] = useState<{ key: string; cells: GridCell[] } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const priorKey = `${draft.fiscalYear}:${grain}`;
  const copyKey = draft.source === 'version' && draft.copyVersionId ? draft.copyVersionId : '';

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void fetchPriorActuals(draft.fiscalYear, grain).then((r) => {
      if (!live) return;
      if (r.ok) setPrior({ key: priorKey, data: r.data }); else setError({ key: priorKey, message: r.message });
    });
    return () => { live = false; };
  }, [enabled, draft.fiscalYear, grain, priorKey]);

  useEffect(() => {
    if (!enabled || copyKey === '') return undefined;
    let live = true;
    void fetchGridCells(copyKey).then((r) => {
      if (!live) return;
      if (r.ok) setCopy({ key: copyKey, cells: r.data.cells }); else setError({ key: copyKey, message: r.message });
    });
    return () => { live = false; };
  }, [enabled, copyKey]);

  return useMemo(() => {
    const pData = prior?.key === priorKey ? prior.data : null;
    const cData = copy?.key === copyKey ? copy.cells : null;
    const failed = error && (error.key === priorKey || error.key === copyKey) ? error.message : null;
    const pct = parsePct(draft.upliftPct);
    const months = years.find((y) => y.fiscalYear === draft.fiscalYear)?.monthKeys ?? [];
    let next: PreviewResult | null = null;
    if (draft.source === 'blank' || draft.source === 'import') next = { ok: true, figures: { turnover: 0, grossProfit: 0, netProfit: 0 } };
    else if (pct === null) next = { ok: false, reason: 'Enter an uplift between -100 and 1000.' };
    else if (draft.source === 'py_actuals' && pData) {
      next = pySeedFigures(accounts, pData, { grain: draft.grain, unassigned: draft.unassigned, includeNoActivity: draft.includeNoActivity, pct, unit: draft.roundingUnit });
    } else if (draft.source === 'version' && cData) {
      const sourceMonths = years.find((y) => y.fiscalYear === draft.copyYear)?.monthKeys ?? [];
      next = versionSeedFigures(accounts, cData, sourceMonths, months.length, pct, draft.roundingUnit);
    }
    const loading = !failed && (pData === null || (copyKey !== '' && cData === null));
    return {
      loading, error: failed,
      prior: pData ? toRand(priorFigures(accounts, pData)) : null,
      next: next && next.ok ? { ok: true, figures: toRand(next.figures) } : next,
    };
  }, [prior, copy, error, priorKey, copyKey, draft, years, accounts]);
}
