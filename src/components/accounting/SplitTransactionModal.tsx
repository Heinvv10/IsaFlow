/**
 * Split Transaction Modal — allocate a single bank transaction
 * across multiple GL accounts (Sage-style split entry).
 * Each line has its own GL account, amount, and VAT treatment.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Trash2, Search, Scissors } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';
import type { BankTx, SelectOption, VatCode } from './BankTxTable';
import { VAT_OPTIONS } from './BankTxTable';

interface SplitLineState {
  id: string; // local key for React rendering
  contraAccountId: string;
  accountLabel: string;
  amount: string; // string to allow free-form input
  vatCode: VatCode;
  description: string;
}

interface Props {
  transaction: BankTx;
  glAccounts: SelectOption[];
  onClose: () => void;
  onSplit: () => void;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

function newLine(amount = ''): SplitLineState {
  return {
    id: crypto.randomUUID(),
    contraAccountId: '',
    accountLabel: '',
    amount,
    vatCode: 'none',
    description: '',
  };
}

export function SplitTransactionModal({ transaction, glAccounts, onClose, onSplit }: Props) {
  const total = Math.abs(transaction.amount);
  const [lines, setLines] = useState<SplitLineState[]>([newLine(total.toFixed(2))]);
  const [submitting, setSubmitting] = useState(false);
  const [openPicker, setOpenPicker] = useState<string | null>(null); // line id with open dropdown
  const [pickerSearch, setPickerSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setOpenPicker(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredAccounts = useCallback((): SelectOption[] => {
    if (!pickerSearch) return glAccounts.slice(0, 30);
    const q = pickerSearch.toLowerCase();
    return glAccounts
      .filter(a => (a.code || '').toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [glAccounts, pickerSearch]);

  const updateLine = (id: string, patch: Partial<SplitLineState>) => {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines(prev => [...prev, newLine()]);

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines(prev => prev.filter(l => l.id !== id));
  };

  const allocated = lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  const remaining = Math.round((total - allocated) * 100) / 100;
  const canSubmit = Math.abs(remaining) <= 0.01 && lines.every(l => l.contraAccountId && parseFloat(l.amount) > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payload = {
        action: 'split_allocate',
        bankTransactionId: transaction.id,
        lines: lines.map(l => ({
          contraAccountId: l.contraAccountId,
          amount: parseFloat(l.amount),
          vatCode: l.vatCode,
          description: l.description || undefined,
        })),
      };
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || json.error || 'Split failed');
      notify.success(`Transaction split into ${lines.length} lines and allocated`);
      onSplit();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : 'Split allocation failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--ff-border-light)]">
          <div className="p-2 rounded-lg bg-purple-500/10">
            <Scissors className="h-4 w-4 text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Split Transaction</h2>
            <p className="text-xs text-[var(--ff-text-tertiary)] truncate">
              {transaction.transactionDate} · {transaction.description || 'No description'}
            </p>
          </div>
          <div className="text-right mr-2">
            <p className={`text-base font-bold font-mono ${transaction.amount < 0 ? 'text-red-400' : 'text-teal-400'}`}>
              {fmtCurrency(transaction.amount)}
            </p>
            <p className="text-xs text-[var(--ff-text-tertiary)]">{transaction.amount < 0 ? 'Spent' : 'Received'}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Split lines */}
        <div className="overflow-y-auto flex-1 p-4 space-y-2" ref={pickerRef}>
          {lines.map((line, idx) => (
            <div key={line.id} className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-3">
              <div className="flex items-center gap-1 mb-2">
                <span className="text-xs font-medium text-[var(--ff-text-tertiary)] w-16 shrink-0">Line {idx + 1}</span>
                {lines.length > 1 && (
                  <button onClick={() => removeLine(line.id)}
                    className="ml-auto p-1 rounded hover:bg-red-500/10 text-red-400">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-[1fr_100px_110px] gap-2">
                {/* GL Account picker */}
                <div className="relative">
                  <button
                    onClick={() => { setOpenPicker(openPicker === line.id ? null : line.id); setPickerSearch(''); }}
                    className={`w-full text-left text-xs px-2 py-1.5 rounded border truncate ${
                      line.contraAccountId
                        ? 'bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)] text-[var(--ff-text-primary)]'
                        : 'bg-amber-500/5 border-amber-500/30 text-amber-400 font-medium'
                    }`}
                  >
                    {line.accountLabel || 'Select GL Account'}
                  </button>
                  {openPicker === line.id && (
                    <div className="absolute z-50 top-full left-0 mt-1 w-80 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
                      <div className="p-2">
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                          <input type="text" placeholder="Search accounts..." value={pickerSearch}
                            onChange={e => setPickerSearch(e.target.value)}
                            className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                            autoFocus />
                        </div>
                      </div>
                      <div className="max-h-44 overflow-y-auto">
                        {filteredAccounts().map(o => (
                          <button key={o.id}
                            onClick={() => {
                              updateLine(line.id, {
                                contraAccountId: o.id,
                                accountLabel: o.code ? `${o.code} ${o.name}` : o.name,
                              });
                              setOpenPicker(null);
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2"
                          >
                            {o.code && <span className="font-mono text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                            <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                          </button>
                        ))}
                        {filteredAccounts().length === 0 && (
                          <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Amount */}
                <input type="number" min="0.01" step="0.01" placeholder="0.00"
                  value={line.amount}
                  onChange={e => updateLine(line.id, { amount: e.target.value })}
                  className="text-xs px-2 py-1.5 rounded bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-right font-mono focus:outline-none focus:border-blue-500"
                />

                {/* VAT */}
                <select value={line.vatCode}
                  onChange={e => updateLine(line.id, { vatCode: e.target.value as VatCode })}
                  className={`text-xs px-1 py-1.5 rounded bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] focus:outline-none ${
                    line.vatCode === 'standard' ? 'text-cyan-400' : 'text-[var(--ff-text-primary)]'
                  }`}
                >
                  {VAT_OPTIONS.map(v => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </div>

              {/* Description (optional) */}
              <input type="text" placeholder="Description (optional)"
                value={line.description}
                onChange={e => updateLine(line.id, { description: e.target.value })}
                className="mt-2 w-full text-xs px-2 py-1.5 rounded bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
              />
            </div>
          ))}

          <button onClick={addLine}
            className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 px-1 py-1">
            <Plus className="h-3.5 w-3.5" /> Add Line
          </button>
        </div>

        {/* Summary footer */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3">
          <div className="flex items-center justify-between mb-3 text-xs">
            <div className="flex items-center gap-6 text-[var(--ff-text-secondary)]">
              <span>Total: <span className="font-mono font-medium text-[var(--ff-text-primary)]">{fmtCurrency(total)}</span></span>
              <span>Allocated: <span className="font-mono font-medium text-[var(--ff-text-primary)]">{fmtCurrency(allocated)}</span></span>
              <span>Remaining:
                <span className={`font-mono font-medium ml-1 ${
                  Math.abs(remaining) <= 0.01 ? 'text-teal-400' : 'text-amber-400'
                }`}>{fmtCurrency(remaining)}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose}
                className="px-3 py-1.5 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]">
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={!canSubmit || submitting}
                className="px-4 py-1.5 rounded text-xs font-medium bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white transition-colors">
                {submitting ? 'Splitting…' : 'Split & Allocate'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
