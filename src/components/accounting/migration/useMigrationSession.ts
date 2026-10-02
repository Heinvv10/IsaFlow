import { useState, useEffect, useCallback } from 'react';
import type { SessionIssue } from '@/components/accounting/migration/SessionIssues';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export interface StepsCompleted {
  coa?: boolean;
  customers?: boolean;
  suppliers?: boolean;
  opening_balances?: boolean;
  ar_invoices?: boolean;
  ap_invoices?: boolean;
  validated?: boolean;
}

export interface MigrationSession {
  id: string;
  sourceSystem: string | null;
  status: string;
  stepsCompleted: StepsCompleted;
  coaRecordsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: boolean;
  arInvoicesImported: number;
  apInvoicesImported: number;
  /**
   * Everything the wizard's steps recorded against this session — per-row
   * failures and, marked `severity: 'warning'`, the rows that DID import with
   * something to look at (R-002 rounding drift). Written for durability across
   * a page reload, so this hub is where it is read back.
   */
  errors?: SessionIssue[];
  startedAt: string;
}

/** The migration hub's session: load, source selection, and why a load failed. */
export function useMigrationSession() {
  const [session, setSession] = useState<MigrationSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState(false);
  // A failed load must not offer the source picker: picking would start a second session beside the real one.
  const [loadFailed, setLoadFailed] = useState(false);

  const loadSession = useCallback(async () => {
    setLoadFailed(false);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration/session');
      await assertOk(res, 'Could not load your migration - try again');
      const json = await res.json();
      if (json.data) {
        const raw = (json.data.session ?? json.data) as Partial<MigrationSession> | null;
        if (raw && typeof raw === 'object' && 'id' in raw) {
          setSession({ ...raw, stepsCompleted: raw.stepsCompleted ?? {} } as MigrationSession);
        }
      }
    } catch (e) {
      log.warn('Failed to load migration session', { error: e }, 'migration');
      setLoadFailed(true);
      setError(apiErrorMessage(e, 'Could not load your migration - try again'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);

  const selectSource = async (sourceSystem: string) => {
    setSelecting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSystem }),
      });
      await assertOk(res, 'Could not start migration - try again');
      const json = await res.json();
      const raw = (json.data.session ?? json.data) as Partial<MigrationSession>;
      setSession({ ...raw, stepsCompleted: raw.stepsCompleted ?? {} } as MigrationSession);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start migration - try again'));
    } finally {
      setSelecting(false);
    }
  };

  return { session, setSession, isLoading, setIsLoading, error, selecting, loadFailed, loadSession, selectSource };
}
