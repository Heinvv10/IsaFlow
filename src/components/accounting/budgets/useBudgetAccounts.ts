/**
 * The accounts the Add Budget picker offers: ACTIVE LEAF revenue and expense
 * accounts (budgets P0, D9). Read with `includeInactive=true` because an
 * inactive child still makes its parent a header (leafAccountOptions).
 */
import { useEffect, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { leafAccountOptions } from '@/lib/chartAccountOptions';
import type { GLAccount as ChartAccount } from '@/modules/accounting/types/gl.types';
import type { GLAccount } from './budgetClient';

export function useBudgetAccounts(): { accounts: GLAccount[]; error: string } {
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/chart-of-accounts?includeInactive=true', { credentials: 'include' });
        await assertOk(res, 'Could not load GL accounts - try again');
        const json = await res.json();
        const data = (json.data ?? json) as ChartAccount[];
        const list = Array.isArray(data) ? data : [];
        const options = [...leafAccountOptions(list, 'revenue'), ...leafAccountOptions(list, 'expense')]
          .sort((a, b) => a.code.localeCompare(b.code));
        if (!stale) setAccounts(options.map((o) => ({ id: o.id, accountCode: o.code, accountName: o.name })));
      } catch (err) {
        if (!stale) setError(apiErrorMessage(err, 'Could not load GL accounts - try again'));
      }
    })();
    return () => { stale = true; };
  }, []);
  return { accounts, error };
}
