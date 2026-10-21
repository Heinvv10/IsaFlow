/**
 * Merchant Categories — map each ISAFlow merchant category to one of this company's own GL accounts.
 *
 * The shared merchant pool (learning loop PR 2) stores which CATEGORY merchants usually fall in, never an
 * account. A pool suggestion ("Common at other ISAFlow clients") reaches this company only for a category
 * mapped here, and this company's coding feeds the pool only through these mappings. Auto-map fills the
 * unmapped categories whose account name is an exact, unique match; every row stays editable.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Tags, Loader2, AlertCircle, Wand2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import type { CategoryMappingView } from '@/modules/accounting/services/sharedPool/categoryMappingService';

interface Account { id: string; accountCode?: string; account_code?: string; accountName?: string; account_name?: string; isActive?: boolean; is_active?: boolean }

const accountLabel = (a: Account) => `${a.accountCode ?? a.account_code ?? ''} — ${a.accountName ?? a.account_name ?? ''}`;

export default function MerchantCategoriesPage() {
  const [categories, setCategories] = useState<CategoryMappingView[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [loadFailed, setLoadFailed] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [acctRes, mapRes] = await Promise.all([
        apiFetch('/api/accounting/chart-of-accounts'),
        apiFetch('/api/accounting/category-mappings'),
      ]);
      await assertOk(acctRes, 'Could not load the merchant categories - try again');
      await assertOk(mapRes, 'Could not load the merchant categories - try again');
      const acctJson = await acctRes.json();
      const mapJson = await mapRes.json();
      const acctData = acctJson.data ?? acctJson;
      const list: Account[] = Array.isArray(acctData) ? acctData : (acctData.accounts ?? []);
      setAccounts(list.filter((a) => (a.isActive ?? a.is_active) !== false));
      const cats = (mapJson.data ?? mapJson).categories;
      if (!Array.isArray(cats)) throw new Error('Could not load the merchant categories - try again');
      setCategories(cats);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      setMessage({ type: 'error', text: apiErrorMessage(err, 'Could not load the merchant categories - try again') });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const post = async (key: string, body: Record<string, unknown>, ok: (data: Record<string, unknown>) => string) => {
    setBusy(key);
    setMessage({ type: '', text: '' });
    try {
      const res = await apiFetch('/api/accounting/category-mappings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      await assertOk(res, 'Could not save - try again');
      const json = await res.json();
      setMessage({ type: 'success', text: ok((json.data ?? json) as Record<string, unknown>) });
    } catch (err) {
      setMessage({ type: 'error', text: apiErrorMessage(err, 'Could not save - try again') });
    } finally {
      setBusy(null);
      await loadData();
    }
  };

  const saveRow = (code: string, glAccountId: string) =>
    post(code, { action: 'save', categoryCode: code, glAccountId: glAccountId || null }, () => 'Saved');
  const autoMap = () => post('auto', { action: 'auto_map' }, (d) => {
    const n = Number(d.mapped ?? 0);
    const amb = Array.isArray(d.ambiguous) ? d.ambiguous.length : 0;
    return `Auto-mapped ${n} ${n === 1 ? 'category' : 'categories'}${amb ? `; ${amb} matched more than one account and were left for you` : ''}`;
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-sky-500/10"><Tags className="h-6 w-6 text-sky-400" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Merchant Categories</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Which of your accounts each ISAFlow category means. Suggestions marked &ldquo;Common at other ISAFlow clients&rdquo; use this map.
                </p>
              </div>
            </div>
            <button onClick={autoMap} disabled={isLoading || loadFailed || busy !== null}
              className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm">
              {busy === 'auto' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Auto-map by account name
            </button>
          </div>
        </div>
        <div className="p-6 max-w-4xl space-y-4">
          {message.text && (
            <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${message.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-teal-500/10 text-teal-400'}`}>
              <AlertCircle className="h-4 w-4" />{message.text}
            </div>
          )}
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-sky-400" /></div>
          ) : loadFailed ? (
            <button onClick={() => { setMessage({ type: '', text: '' }); void loadData(); }}
              className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-primary)]">Try again</button>
          ) : (
            <div className="space-y-2">
              {categories.map((c) => (
                <div key={c.code} className="flex items-center gap-4 p-3 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--ff-text-primary)]">{c.label}</p>
                    <p className="text-xs text-[var(--ff-text-tertiary)]">
                      {!c.poolable ? 'Never shared with other clients' : c.mapping?.source === 'auto' ? 'Auto-mapped by account name' : c.mapping ? 'Mapped' : 'Not mapped'}
                    </p>
                  </div>
                  <select aria-label={c.label} value={c.mapping?.glAccountId ?? ''} disabled={busy !== null}
                    onChange={(e) => void saveRow(c.code, e.target.value)}
                    className="w-80 px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm">
                    <option value="">Not mapped</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
