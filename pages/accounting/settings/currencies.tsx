/**
 * Currencies Reference Page
 * Read-only listing of all supported currencies loaded from API.
 * WORKING: Simple reference table for supported currencies
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiJson } from '@/lib/apiFetch';
import { DollarSign, Loader2, AlertCircle } from 'lucide-react';

interface Currency {
  code: string;
  name: string;
  symbol: string;
}

export default function CurrenciesPage() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // The handler returns the currency array as `data` directly; there is no
      // `data.currencies` wrapper, so this list always rendered empty.
      setCurrencies(await apiJson('/api/accounting/currencies'));
    } catch {
      setError('Failed to load currencies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <DollarSign className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supported Currencies</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  All currencies available in ISAFlow
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-12 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : currencies.length === 0 ? (
            <p className="text-sm text-[var(--ff-text-secondary)] py-8 text-center">
              No currencies found.
            </p>
          ) : (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                {currencies.length} {currencies.length === 1 ? 'currency' : 'currencies'} available
              </p>
              <div className="rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">
                        Code
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">
                        Name
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">
                        Symbol
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {currencies.map(c => (
                      <tr
                        key={c.code}
                        className="bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-primary)] transition-colors"
                      >
                        <td className="px-4 py-3">
                          <span className="font-mono font-semibold text-[var(--ff-text-primary)]">
                            {c.code}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--ff-text-primary)]">{c.name}</td>
                        <td className="px-4 py-3 font-mono text-[var(--ff-text-secondary)]">
                          {c.symbol}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
