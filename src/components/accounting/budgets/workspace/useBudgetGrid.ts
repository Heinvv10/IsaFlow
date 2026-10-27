/**
 * The workspace's data hook (spec §6.4, §7, §10, §11): loads a year's version into the grid store
 * (a response for a year or version the user already left is dropped), fetches prior actuals per
 * view grain lazily (cached), switches the dimension view (PR-A `resolveView` in the store), saves
 * a SNAPSHOT of the dirty cells through the chained commit (edits made during the save stay dirty),
 * keeps a 409 as `stale` with every unsaved edit, and re-applies them over a fresh read with PR-A
 * `rebaseDirty` ("reload and re-apply mine"; also into a draft copy of a locked version).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { rebaseDirty } from '@/modules/accounting/services/budgets/grid/diff';
import type { View } from '@/modules/accounting/services/budgets/grid/pivot';
import { type ChainResult, type GridSelection, type SaveCell, fetchGridCells, fetchGridModel, fetchPriorActuals, saveChained } from './budgetWorkspaceClient';
import { GridStore } from './gridStore';
import { cellsInCents } from './gridStoreParts';
import { committedPart, toSaveCells } from './saveSnapshot';
import type { BudgetVersion, GridStatus, SaveState, StaleState } from './types';

export interface MemberTotal { id: string; code: string; name: string; isActive: boolean; total: number }

export interface BudgetGridApi {
  store: GridStore;
  status: GridStatus;
  error: string | null;
  model: GridReadModel | null;
  version: BudgetVersion | null;
  /** The version token: what the next save (or a status move) sends as `expectedUpdatedAt`. */
  token: string | null;
  dirtyCount: number;
  view: View;
  setView(view: View): void;
  /** The current dimension's members with their FY net profit (cents); [] in the Company view. */
  members: MemberTotal[];
  roundingUnit: RoundingUnit;
  setRoundingUnit(unit: RoundingUnit): void;
  priorStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** null: the year's primary (else newest) version. */
  selectVersion(id: string | null): Promise<void>;
  /** Re-read the version shown (after a status move: new token). */
  reload(): Promise<void>;
  save(): Promise<void>;
  saveState: SaveState;
  discard(): void;
  stale: StaleState | null;
  /** Fresh read + rebaseDirty; `intoVersionId` re-applies into another version (a draft copy of a locked one). */
  reapplyMine(intoVersionId?: string): Promise<void>;
  discardAndReload(): Promise<void>;
  dismissStale(): void;
  compareVersionId: string | null;
  compareError: string | null;
  setCompareVersion(id: string | null): Promise<void>;
  /** An import's cells, chained with the PREVIEW's token; refused while the grid is dirty; reloads after. */
  commitImport(cells: readonly SaveCell[], previewToken: string): Promise<ChainResult>;
}

const COMPANY: View = { kind: 'company' };

export function useBudgetGrid({ fiscalYear, canWrite }: { fiscalYear: number | null; canWrite: boolean }): BudgetGridApi {
  const [store] = useState(() => new GridStore());
  const [status, setStatus] = useState<GridStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<GridReadModel | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(COMPANY);
  const [roundingUnit, setRoundingUnit] = useState<RoundingUnit>(1);
  const [priorStatus, setPriorStatus] = useState<BudgetGridApi['priorStatus']>('idle');
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [stale, setStale] = useState<StaleState | null>(null);
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const dirtyCount = useSyncExternalStore(store.subscribeMeta, () => store.getMeta().dirtyCount, () => store.getMeta().dirtyCount);

  // Refs: the async paths read the latest without re-binding every callback.
  const seq = useRef(0);
  const live = useRef({ model, token, view, canWrite });
  live.current = { model, token, view, canWrite };
  const priorCache = useRef(new Map<string, PriorActuals>());
  const compareCells = useRef<GridCell[] | null>(null);
  const saving = useRef(false);

  const loadPrior = useCallback(async (year: number, grain: View['kind']) => {
    const k = `${year}:${grain}`;
    const cached = priorCache.current.get(k);
    if (cached) { store.setPrior(cached); setPriorStatus('ready'); return; }
    store.setPrior(null);
    setPriorStatus('loading');
    const r = await fetchPriorActuals(year, grain);
    if (live.current.model?.year.fiscalYear !== year || live.current.view.kind !== grain) return;
    if (!r.ok) { setPriorStatus('error'); return; }
    priorCache.current.set(k, r.data);
    store.setPrior(r.data);
    setPriorStatus('ready');
  }, [store]);

  /** Show `m` in the store (optionally with re-applied values), keeping the view when its member still exists. */
  const show = useCallback((m: GridReadModel, overlay?: { values: ReadonlyMap<string, number | null>; conflicts: string[] }) => {
    const v = live.current.view;
    const keep = v.kind === 'company' || m.dimensions[v.kind].some(x => x.id === v.memberId) ? v : COMPANY;
    store.reset(m, { view: keep, canWrite: live.current.canWrite && m.version !== null, ...overlay });
    if (compareCells.current) store.setCompare(compareCells.current);
    live.current = { ...live.current, model: m, token: m.updatedAt, view: keep };
    setModel(m);
    setToken(m.updatedAt);
    setViewState(keep);
    setStatus(m.version ? 'ready' : 'empty');
    void loadPrior(m.year.fiscalYear, keep.kind);
  }, [store, loadPrior]);

  const load = useCallback(async (sel: GridSelection): Promise<void> => {
    const mine = ++seq.current;
    setStatus('loading');
    setError(null);
    const r = await fetchGridModel(sel);
    if (mine !== seq.current) return;
    if (!r.ok) { setModel(null); setToken(null); setError(r.message); setStatus('error'); return; }
    show(r.data);
  }, [show]);

  useEffect(() => {
    if (fiscalYear === null) { seq.current++; setStatus('idle'); return; }
    live.current = { ...live.current, view: COMPANY };
    compareCells.current = null;
    setCompareVersionId(null);
    setStale(null);
    setSaveState({ status: 'idle' });
    void load({ fiscalYear });
  }, [fiscalYear, load]);

  useEffect(() => { store.setAccess(canWrite && live.current.model?.version != null); }, [store, canWrite]);

  /** The version on screen, else the year's default. */
  const reload = useCallback(async () => {
    const id = live.current.model?.version?.id;
    if (id) await load({ versionId: id }); else if (fiscalYear !== null) await load({ fiscalYear });
  }, [load, fiscalYear]);

  const selectVersion = useCallback(async (id: string | null) => {
    setStale(null);
    if (id) await load({ versionId: id }); else if (fiscalYear !== null) await load({ fiscalYear });
  }, [load, fiscalYear]);

  const setView = useCallback((v: View) => {
    live.current = { ...live.current, view: v };
    setViewState(v);
    store.setView(v);
    const year = live.current.model?.year.fiscalYear;
    if (year !== undefined) void loadPrior(year, v.kind);
  }, [store, loadPrior]);

  const save = useCallback(async () => {
    const { model: m, token: t } = live.current;
    const versionId = m?.version?.id;
    if (saving.current || !versionId || !t) return;
    const snapshot = store.dirtyMap();
    if (snapshot.size === 0) return;
    const mine = seq.current;
    saving.current = true;
    setSaveState({ status: 'saving' });
    try {
      const res = await saveChained(versionId, toSaveCells(snapshot), t);
      if (mine !== seq.current) return; // another version or year is on screen now
      const done = res.ok ? snapshot : committedPart(snapshot, res.committed);
      if (done.size > 0) store.markSaved(done);
      live.current = { ...live.current, token: res.updatedAt };
      setToken(res.updatedAt);
      if (res.ok) {
        setSaveState({ status: 'saved', saved: res.saved, deleted: res.deleted });
        store.announce(`Saved ${snapshot.size} change${snapshot.size === 1 ? '' : 's'}`);
        return;
      }
      const f = res.failure;
      if (f.kind === 'stale' || f.kind === 'locked') {
        setSaveState({ status: 'idle' });
        setStale({
          kind: f.kind === 'locked' || f.versionStatus === 'locked' ? 'locked' : 'stale', message: f.message,
          currentUpdatedAt: f.kind === 'stale' ? f.currentUpdatedAt : null, versionStatus: f.kind === 'stale' ? f.versionStatus : 'locked',
          failedChunk: res.failedChunk, chunks: res.chunks, dirtyCount: store.getMeta().dirtyCount,
        });
      } else {
        setSaveState({ status: 'error', message: f.message, retryAfter: 'retryAfter' in f ? f.retryAfter : null });
      }
      store.announce(f.message);
    } finally {
      saving.current = false;
    }
  }, [store]);

  const reapplyMine = useCallback(async (intoVersionId?: string) => {
    const id = intoVersionId ?? live.current.model?.version?.id;
    if (!id) return;
    const original = store.originalMap();
    const mine = store.dirtyMap();
    const ticket = ++seq.current;
    const r = await fetchGridModel({ versionId: id });
    if (ticket !== seq.current) return;
    if (!r.ok) { setSaveState({ status: 'error', message: r.message, retryAfter: 'retryAfter' in r ? r.retryAfter : null }); return; }
    const rebased = rebaseDirty(original, cellsInCents(r.data.cells), mine);
    setStale(null);
    setSaveState({ status: 'idle' });
    show(r.data, { values: rebased.values, conflicts: rebased.conflicts });
    const n = rebased.dirty.size;
    store.announce(`${n} change${n === 1 ? '' : 's'} re-applied${rebased.conflicts.length > 0 ? `; ${rebased.conflicts.length} also changed by someone else` : ''}`);
  }, [store, show]);

  const discard = useCallback(() => { store.discard(); setSaveState({ status: 'idle' }); }, [store]);
  const discardAndReload = useCallback(async () => { store.discard(); setStale(null); await reload(); }, [store, reload]);
  const dismissStale = useCallback(() => setStale(null), []);

  const setCompareVersion = useCallback(async (id: string | null) => {
    setCompareVersionId(id);
    setCompareError(null);
    compareCells.current = null;
    if (!id) { store.setCompare(null); return; }
    const r = await fetchGridCells(id);
    if (!r.ok) { store.setCompare(null); setCompareError(r.message); return; }
    compareCells.current = r.data.cells;
    store.setCompare(r.data.cells);
  }, [store]);

  const commitImport = useCallback(async (cells: readonly SaveCell[], previewToken: string): Promise<ChainResult> => {
    const versionId = live.current.model?.version?.id;
    const n = store.getMeta().dirtyCount;
    if (!versionId || n > 0) {
      const message = versionId ? `Save or discard your ${n} unsaved change${n === 1 ? '' : 's'} before importing.` : 'There is no budget version to import into.';
      return { ok: false, failure: { ok: false, kind: 'invalid', message, code: null }, failedChunk: 0, chunks: 0, committed: [], updatedAt: previewToken, saved: 0, deleted: 0 };
    }
    const res = await saveChained(versionId, cells, previewToken);
    if (res.ok || res.committed.length > 0) await reload();
    return res;
  }, [store, reload]);

  const members = useMemo<MemberTotal[]>(() => {
    if (!model || view.kind === 'company') return [];
    const totals = store.memberTotals(view.kind);
    return model.dimensions[view.kind].map(m => ({ ...m, total: totals.get(m.id) ?? 0 }));
    // The store is mutable: dirtyCount and token are what say its member totals moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, model, view.kind, dirtyCount, token]);

  return {
    store, status, error, model, version: model?.version ?? null, token, dirtyCount, view, setView, members,
    roundingUnit, setRoundingUnit, priorStatus, selectVersion, reload, save, saveState, discard, stale,
    reapplyMine, discardAndReload, dismissStale, compareVersionId, compareError, setCompareVersion, commitImport,
  };
}
