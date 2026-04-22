/**
 * Expense Claims — list (PRD-05 Phase 10)
 * Filter by status, drill to detail, create new.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Plus, RefreshCw, AlertCircle, Loader2, Receipt, ArrowRight, Filter,
} from 'lucide-react';

interface ClaimRow {
  id: string;
  claimNumber: string;
  claimDate: string;
  employeeId: string;
  title: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'paid' | 'cancelled';
  totalAmount: number;
  totalVat: number;
  createdAt: string;
}

const STATUS_LABELS: Record<ClaimRow['status'], { text: string; tone: string }> = {
  draft:     { text: 'Draft',     tone: 'bg-slate-700 text-slate-300' },
  submitted: { text: 'Submitted', tone: 'bg-blue-900/50 text-blue-300' },
  approved:  { text: 'Approved',  tone: 'bg-amber-900/50 text-amber-300' },
  rejected:  { text: 'Rejected',  tone: 'bg-red-900/50 text-red-300' },
  posted:    { text: 'Posted',    tone: 'bg-teal-900/50 text-teal-300' },
  paid:      { text: 'Paid',      tone: 'bg-green-900/50 text-green-300' },
  cancelled: { text: 'Cancelled', tone: 'bg-slate-800 text-slate-500' },
};

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ExpenseClaimsIndex() {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = filter ? `?status=${filter}` : '';
      const res = await apiFetch(`/api/accounting/expense-claims${qs}`);
      const json = await res.json() as { data?: { claims?: ClaimRow[] }; error?: { message?: string } | string };
      if (!res.ok) {
        setError(typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed to load'); return;
      }
      setClaims(json.data?.claims ?? []);
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Expense Claims</h1>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">Employee expenses and mileage</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)]">
              <Filter className="h-3.5 w-3.5 text-slate-500" />
              <select value={filter} onChange={e => setFilter(e.target.value)} className="bg-transparent text-xs text-slate-300 focus:outline-none">
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="approved">Approved</option>
                <option value="posted">Posted</option>
                <option value="paid">Paid</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            <button onClick={() => void load()} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm">
              <RefreshCw className="h-4 w-4" />
            </button>
            <Link href="/accounting/expenses/new" className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New claim
            </Link>
          </div>
        </div>

        <div className="px-6 py-6">
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 text-red-400 py-10 justify-center">
                <AlertCircle className="h-5 w-5" />{error}
              </div>
            ) : claims.length === 0 ? (
              <div className="py-16 text-center">
                <Receipt className="h-8 w-8 mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">No claims yet</p>
                <Link href="/accounting/expenses/new" className="inline-flex items-center gap-1 mt-3 text-xs text-teal-400 hover:text-teal-300">
                  Create your first claim <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
                    <th className="px-6 py-3 font-medium">Claim</th>
                    <th className="px-6 py-3 font-medium">Date</th>
                    <th className="px-6 py-3 font-medium">Title</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 text-right font-medium">VAT</th>
                    <th className="px-6 py-3 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {claims.map(c => (
                    <tr key={c.id} className="hover:bg-white/5 cursor-pointer"
                        onClick={() => { window.location.href = `/accounting/expenses/${c.id}`; }}>
                      <td className="px-6 py-3 text-slate-200 font-mono text-xs">{c.claimNumber}</td>
                      <td className="px-6 py-3 text-slate-400">{c.claimDate}</td>
                      <td className="px-6 py-3 text-slate-300">{c.title ?? '—'}</td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_LABELS[c.status].tone}`}>
                          {STATUS_LABELS[c.status].text}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right text-slate-400">{fmtZAR(c.totalVat)}</td>
                      <td className="px-6 py-3 text-right text-slate-200 font-medium">{fmtZAR(c.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
