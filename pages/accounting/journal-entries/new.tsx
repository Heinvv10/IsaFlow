/**
 * New Journal Entry — redesigned with ISAFlow design system
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { log } from '@/lib/logger';
import { ArrowLeft, Plus, Trash2, Loader2, AlertCircle, CheckCircle2, BookOpen, Receipt } from 'lucide-react';
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

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

const emptyLine = (): LineInput => ({
  key: crypto.randomUUID(),
  accountId: '',
  description: '',
  debitAmount: '',
  creditAmount: '',
});

const fmtR = (n: number) =>
  n === 0 ? 'R 0.00' : `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    apiFetch('/api/accounting/chart-of-accounts')
      .then(r => r.json())
      .then((data: { data?: GLAccount[] } | GLAccount[]) => {
        const list = (data as { data?: GLAccount[] }).data ?? (data as GLAccount[]) ?? [];
        setAccounts(list.filter((a: GLAccount) => a.isActive));
      })
      .catch(err => { log.error('Failed to load accounts', { error: err }, 'journal-new'); });
  }, []);

  const addLine = useCallback(() => setLines(prev => [...prev, emptyLine()]), []);
  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.length > 2 ? prev.filter(l => l.key !== key) : prev);
  }, []);

  const updateLine = useCallback((key: string, field: keyof LineInput, value: string) => {
    setLines(prev => prev.map(l => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      if (field === 'debitAmount' && value) updated.creditAmount = '';
      if (field === 'creditAmount' && value) updated.debitAmount = '';
      return updated;
    }));
  }, []);

  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debitAmount) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.creditAmount) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;
  const diff = Math.abs(totalDebit - totalCredit);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!isBalanced) { setError('Journal entry must be balanced (total debits must equal total credits)'); return; }
    const validLines = lines.filter(l => l.accountId && (parseFloat(l.debitAmount) || parseFloat(l.creditAmount)));
    if (validLines.length < 2) { setError('At least 2 lines with amounts are required'); return; }
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          entryDate, description, source: 'manual', createdBy: 'system',
          lines: validLines.map(l => ({
            glAccountId: l.accountId, description: l.description,
            debit: parseFloat(l.debitAmount) || 0, credit: parseFloat(l.creditAmount) || 0,
          })),
        }),
      });
      if (!res.ok) {
        const errData = await res.json() as { message?: string };
        throw new Error(errData.message || 'Failed to create journal entry');
      }
      const data = await res.json() as { data?: { id?: string }; id?: string };
      const entry = data.data ?? data;
      setSuccess(true);
      setTimeout(() => { void router.push(`/accounting/journal-entries/${entry.id}`); }, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create journal entry';
      setError(msg);
      log.error('Failed to create journal entry', { error: err }, 'journal-new');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting?tab=journal-entries" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Journal Entries
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">Journal Entry</h1>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <form onSubmit={e => void handleSubmit(e)}>
            <div className="max-w-6xl mx-auto flex gap-6 items-start">
              <div className="flex-1 min-w-0 space-y-5">
                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
                  </div>
                )}
                {success && (
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-sm flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0" />Journal entry created. Redirecting…
                  </div>
                )}

                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                    Entry Details
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={lbl}>Entry Date *</label>
                      <input type="date" name="entryDate" value={entryDate} onChange={e => setEntryDate(e.target.value)} required className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Description</label>
                      <DescriptionAutocomplete
                        value={description}
                        onChange={setDescription}
                        entityType="journal_entry"
                        placeholder="e.g. Monthly rent accrual"
                        className={inp}
                      />
                    </div>
                  </div>
                </div>

                <div className={`${card} overflow-hidden`}>
                  <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                      Journal Lines
                    </h3>
                    <button type="button" onClick={addLine} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors">
                      <Plus className="h-3 w-3" />Add Line
                    </button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 w-8">#</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Account</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">Debit</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">Credit</th>
                        <th className="w-10" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {lines.map((line, idx) => (
                        <tr key={line.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                          <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <select name="accountId" value={line.accountId} onChange={e => updateLine(line.key, 'accountId', e.target.value)} className={inp} required>
                              <option value="">Select account…</option>
                              {accounts.map(a => (
                                <option key={a.id} value={a.id}>{a.accountCode} - {a.accountName}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <DescriptionAutocomplete
                              value={line.description}
                              onChange={v => updateLine(line.key, 'description', v)}
                              entityType="journal_entry"
                              placeholder="Line description"
                              className={inp}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" value={line.debitAmount} onChange={e => updateLine(line.key, 'debitAmount', e.target.value)} placeholder="0.00" step="0.01" min="0" className={`${inp} text-right`} />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" value={line.creditAmount} onChange={e => updateLine(line.key, 'creditAmount', e.target.value)} placeholder="0.00" step="0.01" min="0" className={`${inp} text-right`} />
                          </td>
                          <td className="px-2 py-2">
                            <button type="button" onClick={() => removeLine(line.key)} disabled={lines.length <= 2} className="p-1.5 rounded-lg text-slate-700 dark:text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-20">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="w-72 shrink-0">
                <div className="sticky top-6">
                  <div className={`${card} p-5`}>
                    <div className="flex items-center gap-2 mb-5">
                      <Receipt className="w-4 h-4 text-amber-500" />
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Balance Summary</h3>
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Total Debits</span>
                        <span className="font-mono text-slate-900 dark:text-slate-100">{fmtR(totalDebit)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Total Credits</span>
                        <span className="font-mono text-slate-900 dark:text-slate-100">{fmtR(totalCredit)}</span>
                      </div>
                      <div className="h-px bg-slate-100 dark:bg-slate-800" />
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white">Difference</span>
                        <span className={`font-mono font-bold text-lg ${isBalanced ? 'text-emerald-500' : diff > 0 ? 'text-red-500' : 'text-slate-400'}`}>
                          {fmtR(diff)}
                        </span>
                      </div>
                      {totalDebit > 0 && (
                        <div className={`flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 ${isBalanced ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400'}`}>
                          {isBalanced
                            ? <><CheckCircle2 className="h-3.5 w-3.5" />Entry is balanced</>
                            : <><AlertCircle className="h-3.5 w-3.5" />Out of balance</>
                          }
                        </div>
                      )}
                    </div>
                    <button type="submit" disabled={isSubmitting || !isBalanced} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                      {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Posting…</> : 'Post Journal Entry'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
