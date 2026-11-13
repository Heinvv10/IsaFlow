/**
 * The three-way page's data (budgets P6 spec §7, §8): the financial years (the workspace's `useBudgetYears`), the
 * year's versions (P2's list), the version on screen (`?version_id=` when it is one of the year's, else the
 * primary, else the first) and its run (`GET /budget-three-way`). A refused run keeps its message and code (403
 * without the flag, 409 an opening that does not balance, 400 a scenario chain or an invalid stored document),
 * never an empty page. An answer for a version
 * or year the user has left is dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBudgetYears } from '@/components/accounting/budgets/workspace/useWorkspaceVersions';
import { listVersions } from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { BudgetYear } from '@/components/accounting/budgets/budgetClient';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { fetchThreeWay } from './threeWayClient';

export interface ThreeWayData {
  years: BudgetYear[];
  fiscalYear: number | null;
  setFiscalYear(y: number): void;
  versions: BudgetVersion[];
  versionId: string | null;
  select(id: string): void;
  run: ThreeWayView | null;
  error: string | null;
  /** The refused run's contract code (e.g. BUDGET_ASSUMPTIONS_INVALID: the stored document must be replaced). */
  errorCode: string | null;
  loading: boolean;
  reload(): void;
}

/** The version to open: the asked-for one when it is in the list, else the primary, else the first. */
export function pickVersion(versions: readonly BudgetVersion[], wanted: string | null): string | null {
  if (wanted && versions.some((v) => v.id === wanted)) return wanted;
  return (versions.find((v) => v.isPrimary) ?? versions[0])?.id ?? null;
}

export function useThreeWay(initialVersionId: string | null): ThreeWayData {
  const years = useBudgetYears();
  const [fiscalYear, setFiscalYear] = useState<number | null>(null);
  const [versions, setVersions] = useState<BudgetVersion[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [run, setRun] = useState<ThreeWayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bump, setBump] = useState(0);
  const wanted = useRef(initialVersionId);
  const listSeq = useRef(0);
  const runSeq = useRef(0);

  useEffect(() => {
    if (fiscalYear === null && years.initialYear !== null) setFiscalYear(years.initialYear);
    if (years.error) { setError(years.error); setLoading(false); }
  }, [years.initialYear, years.error, fiscalYear]);

  useEffect(() => {
    if (fiscalYear === null) return;
    const mine = ++listSeq.current;
    setLoading(true);
    void listVersions(fiscalYear).then((r) => {
      if (mine !== listSeq.current) return;
      if (!r.ok) { setVersions([]); setVersionId(null); setRun(null); setError(r.message); setLoading(false); return; }
      setVersions(r.data);
      const id = pickVersion(r.data, wanted.current);
      wanted.current = null;
      setVersionId(id);
      if (id === null) { setRun(null); setError(null); setLoading(false); }
    });
  }, [fiscalYear]);

  useEffect(() => {
    if (versionId === null) return;
    const mine = ++runSeq.current;
    setLoading(true);
    void fetchThreeWay(versionId).then((r) => {
      if (mine !== runSeq.current) return;
      setLoading(false);
      if (r.ok) { setRun(r.data); setError(null); setErrorCode(null); return; }
      setRun(null);
      setError(r.message);
      setErrorCode('code' in r ? r.code : null);
    });
  }, [versionId, bump]);

  const select = useCallback((id: string) => setVersionId(id), []);
  const reload = useCallback(() => setBump((n) => n + 1), []);
  const changeYear = useCallback((y: number) => { setFiscalYear(y); setRun(null); }, []);

  return { years: years.years, fiscalYear, setFiscalYear: changeYear, versions, versionId, select, run, error, errorCode, loading, reload };
}
