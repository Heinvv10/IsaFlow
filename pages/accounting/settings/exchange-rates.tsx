/**
 * Exchange Rates Settings Page
 * Manage foreign currency exchange rates — add, view, delete, and convert.
 * WORKING: Full CRUD + currency converter using multi-currency APIs
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { AddRateForm, ConverterWidget } from '@/components/accounting/exchangeRates/ExchangeRateForms';
import type { Currency } from '@/components/accounting/exchangeRates/ExchangeRateForms';
import { TrendingUp, Loader2, AlertCircle, Trash2, RefreshCw } from 'lucide-react';

interface ExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  effectiveDate: string;
}

export default function ExchangeRatesSettingsPage() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [currRes, ratesRes] = await Promise.all([
        apiFetch('/api/accounting/currencies'),
        apiFetch('/api/accounting/exchange-rates'),
      ]);
      const currJson = await currRes.json();
      const ratesJson = await ratesRes.json();
      setCurrencies(currJson.data?.currencies ?? []);
      setRates(ratesJson.data?.rates ?? []);
    } catch {
      setError('Failed to load exchange rate data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(id);
    try {
      const res = await apiFetch(`/api/accounting/exchange-rates?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { message?: string };
        notify.error(json.message || 'Failed to delete rate');
        return;
      }
      notify.success('Exchange rate deleted');
      setRates(prev => prev.filter(r => r.id !== id));
    } catch {
      notify.error('Failed to delete exchange rate');
    } finally {
      setDeleting(null);
    }
  }, []);

  const sortedRates = [...rates].sort(
    (a, b) => a.fromCurrency.localeCompare(b.fromCurrency) || b.effectiveDate.localeCompare(a.effectiveDate),
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <TrendingUp className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Exchange Rates</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Manage foreign currency exchange rates</p>
              </div>
            </div>
            <button
              onClick={loadData}
              className="p-2 rounded-lg text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)] transition-colors"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 py-12 justify-center">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="p-6 max-w-5xl space-y-6">
            {/* Add rate form */}
            <AddRateForm currencies={currencies} onAdded={loadData} />

            {/* Converter */}
            <ConverterWidget currencies={currencies} />

            {/* Rates table */}
            <div>
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">Current Rates</h2>
              {sortedRates.length === 0 ? (
                <p className="text-sm text-[var(--ff-text-secondary)] py-4">No exchange rates recorded yet.</p>
              ) : (
                <div className="rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">From</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">To</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Rate</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Effective Date</th>
                        <th className="px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ff-border-light)]">
                      {sortedRates.map(r => (
                        <tr key={r.id} className="bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                          <td className="px-4 py-3 font-mono font-semibold text-[var(--ff-text-primary)]">{r.fromCurrency}</td>
                          <td className="px-4 py-3 font-mono font-semibold text-[var(--ff-text-primary)]">{r.toCurrency}</td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{r.rate.toFixed(6)}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.effectiveDate}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => handleDelete(r.id)}
                              disabled={deleting === r.id}
                              className="p-1.5 rounded-lg text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                              title="Delete rate"
                            >
                              {deleting === r.id
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Trash2 className="h-4 w-4" />
                              }
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
