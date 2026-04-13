/**
 * Exchange Rate sub-components: AddRateForm + ConverterWidget
 * Used by pages/accounting/settings/exchange-rates.tsx
 * WORKING: Add rate form and currency converter widget
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { Loader2, Plus, ArrowRight } from 'lucide-react';

export interface Currency {
  code: string;
  name: string;
  symbol: string;
}

interface ConvertResult {
  result: number;
  rate: number;
  effectiveDate: string;
}

const today = new Date().toISOString().split('T')[0]!;

const INPUT_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500';

const SELECT_CLS =
  'px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500';

// ── Add Rate Form ─────────────────────────────────────────────────────────────

interface AddRateFormProps {
  currencies: Currency[];
  onAdded: () => void;
}

export function AddRateForm({ currencies, onAdded }: AddRateFormProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('ZAR');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!from || !to || !rate || !date) { notify.error('All fields are required'); return; }
    if (from === to) { notify.error('From and To currencies must differ'); return; }
    const rateVal = parseFloat(rate);
    if (isNaN(rateVal) || rateVal <= 0) { notify.error('Rate must be a positive number'); return; }

    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/exchange-rates', {
        method: 'POST',
        body: JSON.stringify({ fromCurrency: from, toCurrency: to, rate: rateVal, effectiveDate: date }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) { notify.error(json.message || 'Failed to add rate'); return; }
      notify.success(`Rate ${from}/${to} added`);
      setRate('');
      onAdded();
    } catch {
      notify.error('Failed to add exchange rate');
    } finally {
      setSaving(false);
    }
  }, [from, to, rate, date, onAdded]);

  return (
    <div className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
      <div className="flex items-center gap-2 mb-4">
        <Plus className="h-4 w-4 text-teal-500" />
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Add Rate</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">From Currency</label>
          <select value={from} onChange={e => setFrom(e.target.value)} className={INPUT_CLS}>
            <option value="">Select...</option>
            {currencies.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">To Currency</label>
          <select value={to} onChange={e => setTo(e.target.value)} className={INPUT_CLS}>
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
            placeholder="e.g. 18.523400"
            value={rate}
            onChange={e => setRate(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Effective Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <button
          onClick={handleAdd}
          disabled={saving}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add Rate
        </button>
      </div>
    </div>
  );
}

// ── Converter Widget ──────────────────────────────────────────────────────────

interface ConverterWidgetProps {
  currencies: Currency[];
}

export function ConverterWidget({ currencies }: ConverterWidgetProps) {
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('ZAR');
  const [date, setDate] = useState(today);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [converting, setConverting] = useState(false);

  const handleConvert = useCallback(async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { notify.error('Enter a valid amount'); return; }
    if (!from || !to) { notify.error('Select both currencies'); return; }
    setConverting(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/accounting/exchange-rate-convert', {
        method: 'POST',
        body: JSON.stringify({ amount: amt, fromCurrency: from, toCurrency: to, date }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify.error(json.message || 'No rate available for this pair');
        return;
      }
      setResult(json.data as ConvertResult);
    } catch {
      notify.error('Conversion failed');
    } finally {
      setConverting(false);
    }
  }, [amount, from, to, date]);

  return (
    <div className="p-5 rounded-xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Currency Converter</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Amount</label>
          <input
            type="number" step="any" min="0" placeholder="1000" value={amount}
            onChange={e => { setAmount(e.target.value); setResult(null); }}
            className="w-32 px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">From</label>
          <select value={from} onChange={e => { setFrom(e.target.value); setResult(null); }} className={SELECT_CLS}>
            <option value="">Select...</option>
            {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </div>
        <ArrowRight className="h-4 w-4 text-[var(--ff-text-tertiary)] mb-2" />
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">To</label>
          <select value={to} onChange={e => { setTo(e.target.value); setResult(null); }} className={SELECT_CLS}>
            <option value="">Select...</option>
            {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Date</label>
          <input
            type="date" value={date}
            onChange={e => { setDate(e.target.value); setResult(null); }}
            className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
        <button
          onClick={handleConvert}
          disabled={converting}
          className="px-4 py-2 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] hover:border-teal-500 text-[var(--ff-text-primary)] rounded-lg flex items-center gap-2 text-sm transition-colors disabled:opacity-50"
        >
          {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Convert'}
        </button>
      </div>
      {result && (
        <div className="mt-4 px-4 py-3 rounded-lg bg-teal-500/10 border border-teal-500/20 text-sm text-[var(--ff-text-primary)]">
          {formatCurrencyAmount(parseFloat(amount), from)} ={' '}
          <span className="font-bold text-teal-400">{formatCurrencyAmount(result.result, to)}</span>
          {' '}
          <span className="text-[var(--ff-text-tertiary)]">
            (rate: {result.rate.toFixed(6)} on {result.effectiveDate})
          </span>
        </div>
      )}
    </div>
  );
}
