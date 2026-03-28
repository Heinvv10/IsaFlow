/**
 * Multi-Currency Management
 * Sage equivalent: Accounts > Currencies
 * Manage currencies and exchange rates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { DollarSign, Loader2, AlertCircle, Plus, RefreshCw } from 'lucide-react';
import { CurrencyList } from '@/components/accounting/currencies/CurrencyList';
import { ExchangeRatesPanel } from '@/components/accounting/currencies/ExchangeRatesPanel';
import type { Currency, ExchangeRate } from '@/modules/accounting/services/currencyService';
import { apiFetch } from '@/lib/apiFetch';

type ActiveTab = 'currencies' | 'exchange-rates';

export default function CurrenciesPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('currencies');
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [allCurrencies, setAllCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [reportingCurrency, setReportingCurrency] = useState<string>('ZAR');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // 🟢 WORKING: Load all data on mount
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const [activeCurrRes, allCurrRes, ratesRes, settingRes] = await Promise.all([
        apiFetch('/api/accounting/currencies', { credentials: 'include' }),
        apiFetch('/api/accounting/currencies?active=false', { credentials: 'include' }),
        apiFetch('/api/accounting/exchange-rates?limit=50', { credentials: 'include' }),
        apiFetch('/api/accounting/accounting-settings?key=reporting_currency', { credentials: 'include' }),
      ]);

      const activeCurrJson = await activeCurrRes.json();
      const allCurrJson = await allCurrRes.json();
      const ratesJson = await ratesRes.json();

      setCurrencies(Array.isArray(activeCurrJson.data) ? activeCurrJson.data : []);
      setAllCurrencies(Array.isArray(allCurrJson.data) ? allCurrJson.data : []);
      setExchangeRates(Array.isArray(ratesJson.data) ? ratesJson.data : []);

      // Settings endpoint may not exist yet — fallback gracefully
      if (settingRes.ok) {
        const settingJson = await settingRes.json();
        if (settingJson.data?.value) setReportingCurrency(settingJson.data.value);
      }
    } catch {
      setError('Failed to load currency data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const TABS: { id: ActiveTab; label: string }[] = [
    { id: 'currencies', label: 'Currencies' },
    { id: 'exchange-rates', label: 'Exchange Rates' },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-violet-500/10">
                  <DollarSign className="h-6 w-6 text-violet-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Currencies</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Manage currencies and exchange rates
                    {reportingCurrency && (
                      <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-violet-500/10 text-violet-400">
                        Reporting: {reportingCurrency}
                      </span>
                    )}
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

            {/* Tabs */}
            <div className="flex gap-0 mt-4 -mb-4">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-violet-500 text-violet-400'
                      : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="p-6">
            {activeTab === 'currencies' && (
              <CurrencyList
                currencies={allCurrencies}
                reportingCurrency={reportingCurrency}
                onRefresh={loadData}
              />
            )}
            {activeTab === 'exchange-rates' && (
              <ExchangeRatesPanel
                currencies={currencies}
                exchangeRates={exchangeRates}
                onRefresh={loadData}
              />
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
