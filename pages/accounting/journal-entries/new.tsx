/**
 * New Journal Entry Page
 * Create a manual journal entry with balanced debit/credit lines
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { log } from '@/lib/logger';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Save,
} from 'lucide-react';
import type { GLAccount } from '@/modules/accounting/types/gl.types';
import { apiFetch } from '@/lib/apiFetch';
import { DescriptionAutocomplete } from '@/components/accounting/DescriptionAutocomplete';

interface LineInput {
  key: string;
  accountId: string;
  description: string;
  debitAmount: string;
  creditAmount: string;
}

const emptyLine = (): LineInput => ({
  key: crypto.randomUUID(),
  accountId: '',
  description: '',
  debitAmount: '',
  creditAmount: '',
});

export default function NewJournalEntryPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<GLAccount[]>([]);
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]!);
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<LineInput[]>([emptyLine(), emptyLine()]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts');
      const data = await res.json();
      const list = data.data || data || [];
      // Only show leaf accounts (no children / subtype level) for journal lines
      setAccounts(list.filter((a: GLAccount) => a.isActive));
    } catch (err) {
      log.error('Failed to load accounts', { error: err }, 'accounting-ui');
    }
  };

  const addLine = useCallback(() => {
    setLines(prev => [...prev, emptyLine()]);
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.length > 2 ? prev.filter(l => l.key !== key) : prev);
  }, []);

  const updateLine = useCallback((key: string, field: keyof LineInput, value: string) => {
    setLines(prev => prev.map(l => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      // If user enters debit, clear credit and vice versa
      if (field === 'debitAmount' && value) updated.creditAmount = '';
      if (field === 'creditAmount' && value) updated.debitAmount = '';
      return updated;
    }));
  }, []);

  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debitAmount) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.creditAmount) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isBalanced) {
      setError('Journal entry must be balanced (total debits must equal total credits)');
      return;
    }

    const validLines = lines.filter(l => l.accountId && (parseFloat(l.debitAmount) || parseFloat(l.creditAmount)));
    if (validLines.length < 2) {
      setError('At least 2 lines with amounts are required');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          entryDate,
          description,
          source: 'manual',
          createdBy: 'system',
          lines: validLines.map(l => ({
            glAccountId: l.accountId,
            description: l.description,
            debit: parseFloat(l.debitAmount) || 0,
            credit: parseFloat(l.creditAmount) || 0,
          })),
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to create journal entry');
      }

      const data = await res.json();
      const entry = data.data || data;
      setSuccess(true);
      setTimeout(() => {
        router.push(`/accounting/journal-entries/${entry.id}`);
      }, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create journal entry';
      setError(msg);
      log.error('Failed to create journal entry', { error: err }, 'accounting-ui');
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatCurrency = (num: number) =>
    num === 0 ? '-' : `R ${num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/accounting?tab=journal-entries"
              className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors"
            >
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Journal Entry</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Create a manual journal entry</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Error/Success */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
            {success && (
              <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-teal-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-teal-400">Journal entry created successfully. Redirecting...</p>
              </div>
            )}

            {/* Entry Header */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1">
                    Entry Date <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="date"
                    value={entryDate}
                    onChange={e => setEntryDate(e.target.value)}
                    required
                    className="ff-input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1">
                    Description
                  </label>
                  <DescriptionAutocomplete
                    value={description}
                    onChange={setDescription}
                    entityType="journal_entry"
                    placeholder="e.g. Monthly rent accrual"
                    className="ff-input"
                  />
                </div>
              </div>
            </div>

            {/* Journal Lines */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Journal Lines</h3>
                <button
                  type="button"
                  onClick={addLine}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-teal-600 bg-teal-500/10 rounded-lg hover:bg-teal-500/20 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add Line
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] w-10">#</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Account</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Description</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] w-36">Debit</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] w-36">Credit</th>
                      <th className="px-4 py-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={line.key} className="border-b border-[var(--ff-border-light)]">
                        <td className="px-4 py-2 text-sm text-[var(--ff-text-tertiary)]">{idx + 1}</td>
                        <td className="px-4 py-2">
                          <select
                            value={line.accountId}
                            onChange={e => updateLine(line.key, 'accountId', e.target.value)}
                            className="ff-select text-sm py-1.5"
                            required
                          >
                            <option value="">Select account...</option>
                            {accounts.map(a => (
                              <option key={a.id} value={a.id}>
                                {a.accountCode} - {a.accountName}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <DescriptionAutocomplete
                            value={line.description}
                            onChange={v => updateLine(line.key, 'description', v)}
                            entityType="journal_entry"
                            placeholder="Line description"
                            className="ff-input text-sm py-1.5"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={line.debitAmount}
                            onChange={e => updateLine(line.key, 'debitAmount', e.target.value)}
                            placeholder="0.00"
                            step="0.01"
                            min="0"
                            className="ff-input text-sm py-1.5 text-right"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={line.creditAmount}
                            onChange={e => updateLine(line.key, 'creditAmount', e.target.value)}
                            placeholder="0.00"
                            step="0.01"
                            min="0"
                            className="ff-input text-sm py-1.5 text-right"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <button
                            type="button"
                            onClick={() => removeLine(line.key)}
                            disabled={lines.length <= 2}
                            className="p-1.5 rounded text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[var(--ff-bg-tertiary)] border-t-2 border-[var(--ff-border-medium)]">
                      <td colSpan={3} className="px-4 py-3 text-sm font-semibold text-[var(--ff-text-primary)]">
                        Total
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                        {formatCurrency(totalDebit)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                        {formatCurrency(totalCredit)}
                      </td>
                      <td></td>
                    </tr>
                    <tr>
                      <td colSpan={6} className="px-4 py-2">
                        <div className={`flex items-center gap-2 text-sm ${isBalanced ? 'text-teal-400' : totalDebit === 0 && totalCredit === 0 ? 'text-[var(--ff-text-tertiary)]' : 'text-red-400'}`}>
                          {isBalanced ? (
                            <>
                              <CheckCircle2 className="h-4 w-4" />
                              Entry is balanced
                            </>
                          ) : totalDebit === 0 && totalCredit === 0 ? (
                            'Enter debit and credit amounts'
                          ) : (
                            <>
                              <AlertCircle className="h-4 w-4" />
                              Out of balance by {formatCurrency(Math.abs(totalDebit - totalCredit))}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <Link
                href="/accounting?tab=journal-entries"
                className="px-4 py-2 text-sm font-medium text-[var(--ff-text-secondary)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting || !isBalanced}
                className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Create Journal Entry
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
