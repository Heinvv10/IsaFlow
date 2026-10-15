/**
 * Split Transaction Modal — allocate a single bank transaction across several
 * lines (Sage-style split entry). Each line is a GL account (its own VAT and
 * project / BU) or a supplier / customer, which the server settles with its
 * own payment, receipt or refund document (SplitLineRow).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus, Scissors } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch, apiErrorMessage, assertOk, ApiEnvelopeError } from '@/lib/apiFetch';
import type { BankTx, SelectOption } from './BankTxTable';
import { SplitLineRow, type SplitLineState } from './SplitLineRow';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';

interface Props {
  transaction: BankTx;
  glAccounts: SelectOption[];
  /** A line may settle a supplier or customer instead of posting to an account. */
  suppliers?: SelectOption[];
  customers?: SelectOption[];
  /** When given, each account line offers a project (CC2) and BU picker for its cost line. */
  cc2Options?: SelectOption[];
  buOptions?: SelectOption[];
  onClose: () => void;
  onSplit: () => void;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

function newLine(amount = ''): SplitLineState {
  return {
    id: crypto.randomUUID(), target: 'account', targetId: '', targetLabel: '', amount,
    vatCode: 'none', description: '', cc2Id: '', buId: '', leaveOnAccount: false,
  };
}

/** A typed amount as rand and cents: the server takes whole cents only. */
const cents = (raw: string) => Math.round((parseFloat(raw) || 0) * 100) / 100;

/** What the route takes for one line: an account line, or a supplier / customer line. */
function linePayload(l: SplitLineState) {
  const common = { amount: cents(l.amount), description: l.description || undefined };
  if (l.target !== 'account') {
    return { ...common, contactType: l.target, contactId: l.targetId, ...(l.leaveOnAccount ? { autoApply: 'none' } : {}) };
  }
  return { ...common, contraAccountId: l.targetId, vatCode: l.vatCode, cc2Id: l.cc2Id || undefined, buId: l.buId || undefined };
}

export function SplitTransactionModal({
  transaction, glAccounts, suppliers = [], customers = [], cc2Options = [], buOptions = [], onClose, onSplit,
}: Props) {
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

  const optionsFor = useCallback((line: SplitLineState): SelectOption[] => {
    const all = line.target === 'supplier' ? suppliers : line.target === 'customer' ? customers : glAccounts;
    if (!pickerSearch) return all.slice(0, 30);
    const q = pickerSearch.toLowerCase();
    return all.filter(a => (a.code || '').toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).slice(0, 30);
  }, [glAccounts, suppliers, customers, pickerSearch]);

  const updateLine = (id: string, patch: Partial<SplitLineState>) => {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };

  const addLine = () => setLines(prev => [...prev, newLine()]);

  const removeLine = (id: string) => {
    if (lines.length <= 1) return;
    setLines(prev => prev.filter(l => l.id !== id));
  };

  const allocated = lines.reduce((sum, l) => sum + cents(l.amount), 0);
  const remaining = Math.round((total - allocated) * 100) / 100;
  const canSubmit = Math.abs(remaining) <= 0.01 && lines.every(l => l.targetId && cents(l.amount) > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payload = {
        action: 'split_allocate',
        bankTransactionId: transaction.id,
        lines: lines.map(linePayload),
      };
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await assertOk(res, 'Could not split the transaction - try again');
      const json = await res.json();
      if (json.success === false) throw new ApiEnvelopeError(json?.error?.message || 'Could not split the transaction - try again');
      notify.success(`Transaction split into ${lines.length} lines and allocated`);
      notifyLateClaims(json); // VAT claimed in a later period (s16(3))
      onSplit();
    } catch (err) {
      notify.error(apiErrorMessage(err, 'Could not split the transaction - try again'));
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
          <button onClick={onClose} aria-label="Close split" className="p-1.5 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Split lines */}
        <div className="overflow-y-auto flex-1 p-4 space-y-2" ref={pickerRef}>
          {lines.map((line, idx) => (
            <SplitLineRow key={line.id} line={line} index={idx} canRemove={lines.length > 1}
              options={optionsFor(line)} pickerOpen={openPicker === line.id} pickerSearch={pickerSearch}
              cc2Options={cc2Options} buOptions={buOptions}
              onTogglePicker={() => { setOpenPicker(openPicker === line.id ? null : line.id); setPickerSearch(''); }}
              onPickerSearch={setPickerSearch}
              onPick={o => { updateLine(line.id, { targetId: o.id, targetLabel: o.code ? `${o.code} ${o.name}` : o.name }); setOpenPicker(null); }}
              onChange={patch => updateLine(line.id, patch)}
              onTargetChange={target => {
                updateLine(line.id, { target, targetId: '', targetLabel: '' });
                if (openPicker === line.id) setOpenPicker(null);
                setPickerSearch('');
              }}
              onRemove={() => removeLine(line.id)} />
          ))}

          <button onClick={addLine}
            className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 px-1 py-1">
            <Plus className="h-3.5 w-3.5" /> Add Line
          </button>
        </div>

        {/* Summary footer */}
        <div className="border-t border-[var(--ff-border-light)] px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-xs">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[var(--ff-text-secondary)]">
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
                className="px-4 py-1.5 rounded text-xs font-medium bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white transition-colors">
                {submitting ? 'Splitting…' : 'Split & Allocate'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
