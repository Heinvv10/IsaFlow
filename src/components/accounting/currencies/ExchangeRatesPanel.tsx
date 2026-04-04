/**
 * ExchangeRatesPanel — set rates, view history, and quick converter
 * Part of the Multi-Currency Management page
 */

import { useState } from 'react';
import { Save, ArrowRight, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { Currency, ExchangeRate } from '@/modules/accounting/services/currencyService';

interface Props {
  currencies: Currency[];
  exchangeRates: ExchangeRate[];
  onRefresh: () => void;
}

interface RateForm {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
}

interface ConvertForm {
  amount: string;
  from: string;
  to: string;
}

// 🟢 WORKING: Exchange rate management with set-rate form, history table, and quick converter
export function ExchangeRatesPanel({ currencies, exchangeRates, onRefresh }: Props) {
  const today = new Date().toISOString().split('T')[0]!;

  const defaultFrom = currencies.find(c => c.code !== 'ZAR')?.code || '';
  const defaultTo = currencies[0]?.code || 'ZAR';

  const [rateForm, setRateForm] = useState<RateForm>({
    fromCurrency: defaultFrom,
    toCurrency: defaultTo,
    rate: '',
    effectiveDate: today,
  });
  const [savingRate, setSavingRate] = useState(false);

  const [convertForm, setConvertForm] = useState<ConvertForm>({
    amount: '',
    from: defaultFrom,
    to: defaultTo,
  });
  const [convertResult, setConvertResult] = useState<{ converted: number; rate: number } | null>(null);
  const [converting, setConverting] = useState(false);

  const handleSaveRate = async () => {
    if (!rateForm.fromCurrency || !rateForm.toCurrency || !rateForm.rate || !rateForm.effectiveDate) {
      notify.error('All fields are required');
      return;
    }
    if (rateForm.fromCurrency === rateForm.toCurrency) {
      notify.error('From and To currencies must differ');
      return;
    }
    const rateVal = parseFloat(rateForm.rate);
    if (isNaN(rateVal) || rateVal <= 0) {
      notify.error('Rate must be a positive number');
      return;
    }
    setSavingRate(true);
    try {
      const res = await apiFetch('/api/accounting/exchange-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromCurrency: rateForm.fromCurrency,
          toCurrency: rateForm.toCurrency,
          rate: rateVal,
          effectiveDate: rateForm.effectiveDate,
          source: 'manual',
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify.error(json.message || 'Failed to save rate');
        return;
      }
      notify.success(`Rate ${rateForm.fromCurrency}/${rateForm.toCurrency} saved`);
      setRateForm(f => ({ ...f, rate: '' }));
      onRefresh();
    } catch (e) {
      log.error('Exchange rate operation failed', { error: e }, 'currencies');
      notify.error('Failed to save exchange rate');
    } finally {
      setSavingRate(false);
    }
  };

  const handleConvert = async () => {
    const amt = parseFloat(convertForm.amount);
    if (isNaN(amt) || amt <= 0) {
      notify.error('Enter a valid amount');
      return;
    }
    if (!convertForm.from || !convertForm.to) {
      notify.error('Select both currencies');
      return;
    }
    setConverting(true);
    setConvertResult(null);
    try {
      const params = new URLSearchParams({
        convert: 'true',
        from: convertForm.from,
        to: convertForm.to,
        amount: String(amt),
      });
      const res = await apiFetch(`/api/accounting/exchange-rates?${params}`);
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify.error(json.message || 'No rate available for this pair');
        return;
      }
      setConvertResult(json.data);
    } catch (e) {
      log.error('Exchange rate operation failed', { error: e }, 'currencies');
      notify.error('Conversion failed');
    } finally {
      setConverting(false);
    }
  };

  const fromSymbol = (code: string) => currencies.find(c => c.code === code)?.symbol || '';

  return (
    <div className="max-w-4xl space-y-8">
      {/* Set Rate Form */}
      <div>
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Set Exchange Rate</h2>
        <div className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">From Currency</label>
              <select
                value={rateForm.fromCurrency}
                onChange={e => setRateForm(f => ({ ...f, fromCurrency: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              >
                <option value="">Select...</option>
                {currencies.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">To Currency</label>
              <select
                value={rateForm.toCurrency}
                onChange={e => setRateForm(f => ({ ...f, toCurrency: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              >
                <option value="">Select...</option>
                {currencies.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Rate</label>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="e.g. 18.50"
                value={rateForm.rate}
                onChange={e => setRateForm(f => ({ ...f, rate: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Effective Date</label>
              <input
                type="date"
                value={rateForm.effectiveDate}
                onChange={e => setRateForm(f => ({ ...f, effectiveDate: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
          </div>
          <div className="flex justify-end mt-4">
            <button
              onClick={handleSaveRate}
              disabled={savingRate}
              className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm"
            >
              {savingRate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Rate
            </button>
          </div>
        </div>
      </div>

      {/* Quick Converter */}
      <div>
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Quick Converter</h2>
        <div className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Amount</label>
              <input
                type="number"
                step="any"
                min="0"
                placeholder="100"
                value={convertForm.amount}
                onChange={e => { setConvertForm(f => ({ ...f, amount: e.target.value })); setConvertResult(null); }}
                className="w-36 px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">From</label>
              <select
                value={convertForm.from}
                onChange={e => { setConvertForm(f => ({ ...f, from: e.target.value })); setConvertResult(null); }}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              >
                {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            </div>
            <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] mb-2" />
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">To</label>
              <select
                value={convertForm.to}
                onChange={e => { setConvertForm(f => ({ ...f, to: e.target.value })); setConvertResult(null); }}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              >
                {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            </div>
            <button
              onClick={handleConvert}
              disabled={converting}
              className="px-4 py-2 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] hover:border-violet-500 text-[var(--ff-text-primary)] rounded-lg flex items-center gap-2 text-sm transition-colors"
            >
              {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Convert'}
            </button>
            {convertResult && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
                <span className="text-xl font-bold text-violet-400">
                  {fromSymbol(convertForm.to)}{convertResult.converted.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                </span>
                <span className="text-xs text-[var(--ff-text-tertiary)]">@ {convertResult.rate}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Exchange Rates History */}
      <div>
        <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Recent Exchange Rates</h2>
        {exchangeRates.length === 0 ? (
          <p className="text-sm text-[var(--ff-text-secondary)] py-4">No exchange rates recorded yet.</p>
        ) : (
          <div className="rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Pair</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Rate</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Effective</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-light)]">
                {exchangeRates.map(rate => (
                  <tr key={rate.id} className="bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                    <td className="px-4 py-3 font-mono font-semibold text-[var(--ff-text-primary)]">
                      {rate.fromCurrency} <span className="text-[var(--ff-text-tertiary)]">/</span> {rate.toCurrency}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                      {rate.rate.toLocaleString('en-ZA', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{rate.effectiveDate}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] capitalize">
                        {rate.source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
