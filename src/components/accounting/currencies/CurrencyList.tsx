/**
 * CurrencyList — displays all currencies with toggle and add controls
 * Part of the Multi-Currency Management page
 */

import { useState } from 'react';
import { Plus, Loader2, Check, X, Star } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { Currency } from '@/modules/accounting/services/currencyService';

interface Props {
  currencies: Currency[];
  reportingCurrency: string;
  onRefresh: () => void;
}

interface AddForm {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: string;
}

const EMPTY_FORM: AddForm = { code: '', name: '', symbol: '', decimalPlaces: '2' };

// 🟢 WORKING: Currency list with inline add form and active toggle
export function CurrencyList({ currencies, reportingCurrency, onRefresh }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!form.code.trim() || !form.name.trim() || !form.symbol.trim()) {
      notify.error('Code, name, and symbol are required');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/currencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          symbol: form.symbol.trim(),
          decimalPlaces: parseInt(form.decimalPlaces, 10) || 2,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify.error(json.message || 'Failed to create currency');
        return;
      }
      notify.success(`Currency ${form.code.toUpperCase()} created`);
      setForm(EMPTY_FORM);
      setShowAdd(false);
      onRefresh();
    } catch (e) {
      log.error('Currency operation failed', { error: e }, 'currencies');
      notify.error('Failed to create currency');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (currency: Currency) => {
    setToggling(currency.code);
    try {
      const res = await apiFetch('/api/accounting/currencies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: currency.code, isActive: !currency.isActive }),
      });
      if (!res.ok) {
        notify.error('Failed to update currency');
        return;
      }
      notify.success(`${currency.code} ${!currency.isActive ? 'activated' : 'deactivated'}`);
      onRefresh();
    } catch (e) {
      log.error('Currency operation failed', { error: e }, 'currencies');
      notify.error('Failed to update currency');
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          {currencies.length} {currencies.length === 1 ? 'currency' : 'currencies'} configured
        </p>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg flex items-center gap-1.5 text-sm"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Currency
        </button>
      </div>

      {/* Inline add form */}
      {showAdd && (
        <div className="p-4 rounded-xl border border-violet-500/30 bg-violet-500/5 space-y-4">
          <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">New Currency</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Code *</label>
              <input
                type="text"
                maxLength={3}
                placeholder="USD"
                value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500 uppercase"
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Name *</label>
              <input
                type="text"
                placeholder="US Dollar"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Symbol *</label>
              <input
                type="text"
                maxLength={4}
                placeholder="$"
                value={form.symbol}
                onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Decimals</label>
              <input
                type="number"
                min={0}
                max={6}
                value={form.decimalPlaces}
                onChange={e => setForm(f => ({ ...f, decimalPlaces: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-violet-500"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowAdd(false); setForm(EMPTY_FORM); }}
              className="px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg text-sm flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save Currency
            </button>
          </div>
        </div>
      )}

      {/* Currency table */}
      {currencies.length === 0 ? (
        <div className="text-center py-10 text-[var(--ff-text-secondary)]">
          No currencies configured
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Code</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Symbol</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Decimals</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ff-border-light)]">
              {currencies.map(currency => (
                <tr key={currency.code} className="bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-[var(--ff-text-primary)]">{currency.code}</span>
                      {currency.code === reportingCurrency && (
                        <span title="Reporting currency">
                          <Star className="h-3 w-3 text-amber-400" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">{currency.name}</td>
                  <td className="px-4 py-3 font-mono text-[var(--ff-text-secondary)]">{currency.symbol}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{currency.decimalPlaces}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      currency.isActive
                        ? 'bg-teal-500/10 text-teal-400'
                        : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]'
                    }`}>
                      {currency.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {currency.code !== reportingCurrency && (
                      <button
                        onClick={() => handleToggle(currency)}
                        disabled={toggling === currency.code}
                        className={`text-xs px-3 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                          currency.isActive
                            ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
                            : 'border-teal-500/30 text-teal-400 hover:bg-teal-500/10'
                        }`}
                      >
                        {toggling === currency.code
                          ? <Loader2 className="h-3 w-3 animate-spin inline" />
                          : currency.isActive ? <><X className="h-3 w-3 inline mr-1" />Deactivate</> : <><Check className="h-3 w-3 inline mr-1" />Activate</>
                        }
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
