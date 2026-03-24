/**
 * Exchange Rates Page
 * Standalone page wrapping ExchangeRatesPanel with amber branding
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingUp, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { ExchangeRatesPanel } from '@/components/accounting/currencies/ExchangeRatesPanel';
import type { Currency, ExchangeRate } from '@/modules/accounting/services/currencyService';

export default function ExchangeRatesPage() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [currRes, ratesRes] = await Promise.all([
        fetch('/api/accounting/currencies', { credentials: 'include' }),
        fetch('/api/accounting/exchange-rates?limit=50', { credentials: 'include' }),
      ]);
      const currJson = await currRes.json();
      const ratesJson = await ratesRes.json();
      setCurrencies(Array.isArray(currJson.data) ? currJson.data : []);
      setExchangeRates(Array.isArray(ratesJson.data) ? ratesJson.data : []);
    } catch {
      setError('Failed to load exchange rate data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <TrendingUp className="h-6 w-6 text-amber-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Exchange Rates</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Manage exchange rates and convert currencies
                  </p>
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
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="p-6">
            <ExchangeRatesPanel
              currencies={currencies}
              exchangeRates={exchangeRates}
              onRefresh={loadData}
            />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
