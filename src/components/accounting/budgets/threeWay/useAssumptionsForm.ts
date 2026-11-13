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
 * - A stored document that no longer validates (400 BUDGET_ASSUMPTIONS_INVALID on the read) leaves no token:
 *   `invalidDoc` holds the issues and `replaceWithDerived()` loads the derive service's defaults as a full document.
 *   Its save sends no token (null); the server's 409 names the row's token, and only after the user confirms
 *   (`confirmReplace`) is the save retried ONCE with it. A second 409 is the ordinary reload prompt.
 *   A SCENARIO over a base (`scenarioWithBase`) is reset instead (`resetToBase`): it stores EMPTY overrides, so it
 *   follows its base again, through the same no-token / confirm / one-retry save, then re-reads.
 * - The payable pickers offer only the accounts the server accepts (`eligiblePayableAccounts`).
 * - A scenario's save compares with its BASE's resolved document (read beside it), so a field edited back to the
 *   base's value drops its override (review L7). Until that base document has loaded, a scenario's save is blocked
 *   with the reason (`baseBlock`) and `retryBase()` re-reads it: never a silent fallback (round 2).
 * - Every answer (read, save, derive) is checked against `seq`: one in flight when the version changes or the row
 *   is re-read never writes into the new form (review L6).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import type { AssumptionsView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { fetchAssumptions, fetchChartOfAccounts, fetchDerive, fetchLoans, saveAssumptionsDoc, type LoanOption } from './threeWayClient';
import { buildSaveDoc, eligiblePayableAccounts, savesOverrides, type CoaAccount } from './assumptionsModel';

/** A scenario's reset: no overrides, so it resolves to its base. */
export const EMPTY_OVERRIDES = { schemaVersion: 1, overrides: {} } as const;
type SaveMode = 'form' | 'followBase';

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
  /** The stored document no longer validates: its issues, and why a replacement failed (if it did). */
  invalidDoc: { message: string; issues: string[]; replaceError: string | null } | null;
  /** The form holds the derived defaults that will replace the invalid document. */
  replacing: boolean;
  /** The save without a token met a stored row: confirm to retry once with this token. */
  replaceToken: string | null;
  replaceWithDerived(): Promise<void>;
  /** A scenario's save needs its base's resolved document: why the save is blocked (loading, failed), else null. */
  baseBlock: string | null;
  baseFailed: boolean;
  retryBase(): void;
  /** A scenario over a base: store empty overrides so it follows the base again. */
  resetToBase(): Promise<void>;
  confirmReplace(): Promise<void>;
  update(next: (doc: ThreeWayAssumptions) => ThreeWayAssumptions): void;
  save(): Promise<void>;
  reload(): void;
  discard(): void;
}

export function useAssumptionsForm(versionId: string, locked: boolean, onSaved: () => void, scenarioWithBase = false): AssumptionsForm {
  const [view, setView] = useState<AssumptionsView | null>(null);
  const [edited, setEdited] = useState<ThreeWayAssumptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AssumptionsForm['saveError']>(null);
  const [stale, setStale] = useState(false);
  const [lockedOnSave, setLockedOnSave] = useState(false);
  const [coa, setCoa] = useState<CoaAccount[]>([]);
  const [loans, setLoans] = useState<LoanOption[]>([]);
  const [generation, setGeneration] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [invalidDoc, setInvalidDoc] = useState<AssumptionsForm['invalidDoc']>(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceToken, setReplaceToken] = useState<string | null>(null);
  const seq = useRef(0);
  const replaceMode = useRef<SaveMode>('form');
  const [base, setBase] = useState<ThreeWayAssumptions | null>(null);
  const [baseState, setBaseState] = useState<'none' | 'loading' | 'loaded' | 'failed'>('none');

  /** The base's resolved document (a scenario's save compares with it); `mine` drops an answer the form moved past. */
  const loadBase = useCallback((baseId: string, mine: number) => {
    setBaseState('loading');
    void fetchAssumptions(baseId).then((b) => {
      if (mine !== seq.current) return;
      if (b.ok) { setBase(b.data.resolved); setBaseState('loaded'); } else { setBase(null); setBaseState('failed'); }
    });
  }, []);

  useEffect(() => {
    const mine = ++seq.current;
    setLoadError(null);
    setInvalidDoc(null);
    setReplacing(false);
    setReplaceToken(null);
    setSaving(false);
    setBase(null);
    setBaseState('none');
    void fetchAssumptions(versionId).then((r) => {
      if (mine !== seq.current) return;
      if (!r.ok) {
        setView(null);
        setEdited(null);
        if (r.kind === 'invalidDoc') setInvalidDoc({ message: r.message, issues: r.issues, replaceError: null });
        else setLoadError(r.message);
        return;
      }
      setView(r.data);
      setEdited(r.data.resolved);
      const baseId = r.data.version.basedOnVersionId;
      if (savesOverrides(r.data) && baseId) loadBase(baseId, mine);
      setGeneration((g) => g + 1);
      setStale(false);
      setSaveError(null);
    });
  }, [versionId, attempt, loadBase]);

  useEffect(() => {
    let gone = false;
    void fetchChartOfAccounts().then((r) => { if (!gone && r.ok) setCoa(r.data); });
    void fetchLoans().then((r) => { if (!gone && r.ok) setLoans(r.data); });
    return () => { gone = true; };
  }, []);

  useEffect(() => { setLockedOnSave(false); }, [versionId]);

  const accounts = useMemo<LiabilityOption[]>(() => {
    const loanAccounts = new Set(loans.map((l) => l.glAccountId?.toLowerCase()).filter((x): x is string => typeof x === 'string'));
    return eligiblePayableAccounts(coa, loanAccounts).map(({ id, accountCode, accountName }) => ({ id, accountCode, accountName }));
  }, [coa, loans]);

  const statusLocked = view?.version.status === 'locked';
  const readOnly = locked || statusLocked || lockedOnSave;
  const readOnlyReason = readOnly ? 'This version is locked: its assumptions are read-only until an owner unlocks it.' : null;
  const baseBlock = baseState === 'loading' ? "Loading the base version's assumptions…"
    : baseState === 'failed' ? "Base version's assumptions not loaded — retry" : null;
  const retryBase = useCallback(() => {
    const baseId = view?.version.basedOnVersionId;
    if (baseId && baseState === 'failed') loadBase(baseId, seq.current);
  }, [view, baseState, loadBase]);
  const dirty = view !== null && edited !== null && (replacing || JSON.stringify(view.resolved) !== JSON.stringify(edited));

  const update = useCallback((next: (doc: ThreeWayAssumptions) => ThreeWayAssumptions) => {
    setEdited((d) => (d ? next(d) : d));
  }, []);

  /** One PUT. `retried`: this is the confirmed retry of a replacement (never retried again). */
  const send = useCallback(async (token: string | null, retried: boolean, mode: SaveMode) => {
    if (readOnly || (mode === 'form' && (!view || !edited || baseBlock !== null))) return;
    setSaving(true);
    setSaveError(null);
    const doc = mode === 'followBase' ? EMPTY_OVERRIDES : buildSaveDoc(view as AssumptionsView, edited as ThreeWayAssumptions, base);
    const mine = seq.current;
    let r: Awaited<ReturnType<typeof saveAssumptionsDoc>>;
    try {
      r = await saveAssumptionsDoc(versionId, doc, token);
    } finally {
      // Never left saving (a throw included); a form that moved on was reset by its own load.
      if (mine === seq.current) setSaving(false);
    }
    if (mine !== seq.current) return; // the form moved on (another version, or re-read): this answer is not its
    if (r.ok) {
      setReplacing(false);
      setInvalidDoc(null);
      if (mode === 'followBase') setAttempt((n) => n + 1);
      else setView({ ...(view as AssumptionsView), stored: { doc: r.data.doc, updatedAt: r.data.updatedAt, updatedBy: r.data.updatedBy }, resolved: edited as ThreeWayAssumptions });
      onSaved();
      return;
    }
    if (r.kind === 'stale') {
      const replacement = mode === 'followBase' || replacing;
      if (replacement && !retried && r.currentUpdatedAt !== null) { replaceMode.current = mode; setReplaceToken(r.currentUpdatedAt); return; }
      setStale(true);
      return;
    }
    if (r.kind === 'locked') { setLockedOnSave(true); return; }
    setSaveError({ message: r.message, issues: r.kind === 'invalid' ? r.issues : [] });
  }, [view, edited, readOnly, versionId, onSaved, replacing, base, baseBlock]);

  const save = useCallback(() => send(replacing ? null : view?.stored?.updatedAt ?? null, false, 'form'), [send, replacing, view]);

  const confirmReplace = useCallback(async () => {
    const token = replaceToken;
    setReplaceToken(null);
    if (token !== null) await send(token, true, replaceMode.current);
  }, [replaceToken, send]);

  const resetToBase = useCallback(async () => {
    if (!scenarioWithBase) return;
    await send(null, false, 'followBase');
  }, [scenarioWithBase, send]);

  const replaceWithDerived = useCallback(async () => {
    if (readOnly) return;
    const mine = seq.current;
    const r = await fetchDerive(versionId);
    if (mine !== seq.current) return;
    if (!r.ok) { setInvalidDoc((d) => (d ? { ...d, replaceError: r.message } : d)); return; }
    const { version, assumptions, evidence } = r.data;
    setView({ version, stored: null, resolved: assumptions, chain: [version.id], derived: { assumptions, evidence }, warnings: [] });
    setEdited(assumptions);
    setReplacing(true);
    setGeneration((g) => g + 1);
  }, [readOnly, versionId]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const discard = useCallback(() => { if (view) setEdited(view.resolved); setSaveError(null); }, [view]);

  return { view, edited, loadError, saving, saveError, stale, readOnly, readOnlyReason, dirty, accounts, loans, generation,
    invalidDoc, replacing, replaceToken, replaceWithDerived, resetToBase, baseBlock, baseFailed: baseState === 'failed', retryBase, confirmReplace, update, save, reload, discard };
}
