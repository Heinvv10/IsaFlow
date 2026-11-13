/**
 * The Assumptions tab's state (budgets P6 spec §13.18): the row as read (stored doc, its token, the resolved and
 * the derived documents), the user's edits, and the save.
 *
 * - The save sends the token the row was READ with (`stored.updatedAt`, null when nothing is stored). 409 STALE
 *   keeps the edits and raises `stale`; `reload()` re-reads the row (their figures, the new token) and drops the
 *   edits. Nothing overwrites another user's save.
 * - A locked version (its status, the page's `locked`, or a 409 LOCKED on save) is read-only.
 * - A save that succeeds becomes the row as read (no re-read): its token is the next save's, and `onSaved` re-runs
 *   the three-way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import type { AssumptionsView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { fetchAssumptions, fetchLiabilityAccounts, fetchLoans, saveAssumptionsDoc, type LoanOption } from './threeWayClient';
import { buildSaveDoc } from './assumptionsModel';

export interface LiabilityOption { id: string; accountCode: string; accountName: string }

export interface AssumptionsForm {
  view: AssumptionsView | null;
  edited: ThreeWayAssumptions | null;
  loadError: string | null;
  saving: boolean;
  saveError: { message: string; issues: string[] } | null;
  stale: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  dirty: boolean;
  accounts: LiabilityOption[];
  loans: LoanOption[];
  /** Bumps on every successful read: the form remounts its inputs (drops what was typed). */
  generation: number;
  update(next: (doc: ThreeWayAssumptions) => ThreeWayAssumptions): void;
  save(): Promise<void>;
  reload(): void;
  discard(): void;
}

export function useAssumptionsForm(versionId: string, locked: boolean, onSaved: () => void): AssumptionsForm {
  const [view, setView] = useState<AssumptionsView | null>(null);
  const [edited, setEdited] = useState<ThreeWayAssumptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AssumptionsForm['saveError']>(null);
  const [stale, setStale] = useState(false);
  const [lockedOnSave, setLockedOnSave] = useState(false);
  const [accounts, setAccounts] = useState<LiabilityOption[]>([]);
  const [loans, setLoans] = useState<LoanOption[]>([]);
  const [generation, setGeneration] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoadError(null);
    void fetchAssumptions(versionId).then((r) => {
      if (mine !== seq.current) return;
      if (!r.ok) { setView(null); setEdited(null); setLoadError(r.message); return; }
      setView(r.data);
      setEdited(r.data.resolved);
      setGeneration((g) => g + 1);
      setStale(false);
      setSaveError(null);
    });
  }, [versionId, attempt]);

  useEffect(() => {
    let gone = false;
    void fetchLiabilityAccounts().then((r) => { if (!gone && r.ok) setAccounts(r.data); });
    void fetchLoans().then((r) => { if (!gone && r.ok) setLoans(r.data); });
    return () => { gone = true; };
  }, []);

  useEffect(() => { setLockedOnSave(false); }, [versionId]);

  const statusLocked = view?.version.status === 'locked';
  const readOnly = locked || statusLocked || lockedOnSave;
  const readOnlyReason = readOnly ? 'This version is locked: its assumptions are read-only until an owner unlocks it.' : null;
  const dirty = view !== null && edited !== null && JSON.stringify(view.resolved) !== JSON.stringify(edited);

  const update = useCallback((next: (doc: ThreeWayAssumptions) => ThreeWayAssumptions) => {
    setEdited((d) => (d ? next(d) : d));
  }, []);

  const save = useCallback(async () => {
    if (!view || !edited || readOnly) return;
    setSaving(true);
    setSaveError(null);
    const r = await saveAssumptionsDoc(versionId, buildSaveDoc(view, edited), view.stored?.updatedAt ?? null);
    setSaving(false);
    if (r.ok) {
      setView({ ...view, stored: { doc: r.data.doc, updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy }, resolved: edited });
      onSaved();
      return;
    }
    if (r.kind === 'stale') { setStale(true); return; }
    if (r.kind === 'locked') { setLockedOnSave(true); return; }
    setSaveError({ message: r.message, issues: r.kind === 'invalid' ? r.issues : [] });
  }, [view, edited, readOnly, versionId, onSaved]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const discard = useCallback(() => { if (view) setEdited(view.resolved); setSaveError(null); }, [view]);

  return { view, edited, loadError, saving, saveError, stale, readOnly, readOnlyReason, dirty, accounts, loans, generation, update, save, reload, discard };
}
