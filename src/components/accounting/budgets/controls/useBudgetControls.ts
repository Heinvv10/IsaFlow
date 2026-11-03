/**
 * The budget controls page's state (budgets P5-4): the controls view (settings, overrides, picker
 * options, email switch, last evaluated) for every write role, and the alert list for owners and
 * admins only (the route refuses others, so the page never asks). Every write answers with fresh
 * data or a failure sentence; a failed refresh keeps the last good data beside the error.
 */
import { useCallback, useEffect, useState } from 'react';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import {
  deleteOverride, evaluateNow, fetchAlerts, fetchControls, saveOverride, saveSettings,
  type BudgetAlertList, type CheckPolicy, type ControlsView, type OverrideDraft,
} from './controlsClient';

export interface BudgetControlsState {
  view: ControlsView | null;
  alerts: BudgetAlertList | null;
  loading: boolean;
  loadError: string;
  alertsError: string;
  busy: '' | 'settings' | 'override' | 'evaluate';
  /** The last write's outcome, for the page's status line. */
  notice: { tone: 'ok' | 'error'; text: string } | null;
  reload: () => void;
  save: (patch: { checkPolicy?: CheckPolicy; defaultThresholds?: number[]; alertEmailEnabled?: boolean }) => Promise<boolean>;
  addOverride: (draft: OverrideDraft) => Promise<boolean>;
  removeOverride: (id: string) => Promise<void>;
  evaluate: () => Promise<void>;
}

export function useBudgetControls(canAdmin: boolean, enabled: boolean): BudgetControlsState {
  const [view, setView] = useState<ControlsView | null>(null);
  const [alerts, setAlerts] = useState<BudgetAlertList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [alertsError, setAlertsError] = useState('');
  const [busy, setBusy] = useState<BudgetControlsState['busy']>('');
  const [notice, setNotice] = useState<BudgetControlsState['notice']>(null);
  const [tick, setTick] = useState(0);

  const loadAlerts = useCallback(async () => {
    if (!canAdmin) return;
    const r = await fetchAlerts();
    if (r.ok) { setAlerts(r.data); setAlertsError(''); } else setAlertsError(failureText(r));
  }, [canAdmin]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const r = await fetchControls();
      if (cancelled) return;
      if (r.ok) { setView(r.data); setLoadError(''); } else setLoadError(failureText(r));
      await loadAlerts();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [enabled, tick, loadAlerts]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const save = useCallback(async (patch: Parameters<BudgetControlsState['save']>[0]) => {
    setBusy('settings');
    const r = await saveSettings(patch);
    setBusy('');
    if (!r.ok) { setNotice({ tone: 'error', text: failureText(r) }); return false; }
    setView(r.data);
    setNotice({ tone: 'ok', text: 'Budget controls saved.' });
    return true;
  }, []);

  /** Re-reads the view after a write; a failed read keeps the last good view and says so. */
  const refreshView = useCallback(async () => {
    const r = await fetchControls();
    if (!r.ok) {
      setLoadError(failureText(r));
      return;
    }
    setView(r.data);
    setLoadError('');
  }, []);

  const addOverride = useCallback(async (draft: OverrideDraft) => {
    setBusy('override');
    const r = await saveOverride(draft);
    if (r.ok) await refreshView();
    setBusy('');
    setNotice(r.ok ? { tone: 'ok', text: `Thresholds for ${r.data.accountCode} ${r.data.accountName} saved.` } : { tone: 'error', text: failureText(r) });
    return r.ok;
  }, [refreshView]);

  const removeOverride = useCallback(async (id: string) => {
    setBusy('override');
    const r = await deleteOverride(id);
    if (r.ok) await refreshView();
    setBusy('');
    setNotice(r.ok ? { tone: 'ok', text: 'Override removed: the account uses the default thresholds again.' } : { tone: 'error', text: failureText(r) });
  }, [refreshView]);

  const evaluate = useCallback(async () => {
    setBusy('evaluate');
    const r = await evaluateNow();
    if (r.ok) {
      await loadAlerts();
      await refreshView();
    }
    setBusy('');
    setNotice(r.ok
      ? { tone: 'ok', text: `Evaluated ${r.data.keys} budget line-months: ${r.data.fired} new alert${r.data.fired === 1 ? '' : 's'}, ${r.data.resolved} resolved.` }
      : { tone: 'error', text: failureText(r) });
  }, [loadAlerts, refreshView]);

  return { view, alerts, loading, loadError, alertsError, busy, notice, reload, save, addOverride, removeOverride, evaluate };
}
