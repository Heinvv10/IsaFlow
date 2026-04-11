/**
 * Tax Directives Page — SARS Lump Sum directive management
 * Route: /payroll/tax-directives
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { FileText, Plus, Loader2 } from 'lucide-react';
import type { TaxDirective } from '@/modules/accounting/services/taxDirectiveService';
import { CreateTaxDirectiveModal, LumpSumCalculator } from '@/components/payroll/TaxDirectiveComponents';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (d: string | Date | null) => {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-ZA');
};

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-amber-500/10 text-amber-400 border border-amber-500/30',
  approved:  'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  expired:   'bg-gray-500/10 text-gray-400 border border-gray-500/30',
  cancelled: 'bg-red-500/10 text-red-400 border border-red-500/30',
};

const STATUSES = ['pending', 'approved', 'expired', 'cancelled'] as const;

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TaxDirectivesPage() {
  const [directives, setDirectives] = useState<TaxDirective[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/tax-directives?${params}`, { credentials: 'include' });
      const json = await res.json();
      setDirectives(json.data ?? []);
    } catch {
      setDirectives([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (id: string, status: string) => {
    setUpdating(id);
    try {
      await apiFetch(`/api/accounting/tax-directives?id=${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await load();
    } finally {
      setUpdating(null);
    }
  };

  return (
    <AppLayout>
      {showCreate && (
        <CreateTaxDirectiveModal onClose={() => setShowCreate(false)} onCreated={load} />
      )}

      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white">Tax Directives</h1>
                <p className="text-sm text-gray-400">SARS lump sum, retirement, severance & death directives</p>
              </div>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Directive
            </button>
          </div>
        </div>

        <div className="p-6">
          <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
            {/* Table — 3/4 width */}
            <div className="xl:col-span-3 space-y-4">
              {/* Status filter tabs */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setStatusFilter('')}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${!statusFilter ? 'bg-teal-500/20 text-teal-300 border-teal-500/40' : 'text-gray-400 border-gray-600 hover:text-white'}`}
                >
                  All
                </button>
                {STATUSES.map(s => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1.5 text-xs rounded-full border capitalize transition-colors ${statusFilter === s ? 'bg-teal-500/20 text-teal-300 border-teal-500/40' : 'text-gray-400 border-gray-600 hover:text-white'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>

              {/* Directives table */}
              <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                {loading ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-8 w-8 animate-spin text-teal-400" />
                  </div>
                ) : directives.length === 0 ? (
                  <div className="text-center py-16 text-gray-500">
                    <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p>No tax directives found</p>
                    <p className="text-sm mt-1">Click &ldquo;New Directive&rdquo; to add one</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-700 bg-gray-750">
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Employee</th>
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Type</th>
                          <th className="text-right px-4 py-3 text-xs font-medium text-gray-400">Amount</th>
                          <th className="text-right px-4 py-3 text-xs font-medium text-gray-400">Rate / Table</th>
                          <th className="text-right px-4 py-3 text-xs font-medium text-gray-400">Tax Amount</th>
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Effective Date</th>
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Status</th>
                          <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-700">
                        {directives.map(d => (
                          <tr key={d.id} className="hover:bg-gray-700/30 transition-colors">
                            <td className="px-4 py-3">
                              <div className="text-white font-medium">{d.employee_name}</div>
                              {d.employee_tax_number && (
                                <div className="text-xs text-gray-400">{d.employee_tax_number}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 capitalize text-gray-300">
                              {d.directive_type.replace('_', ' ')}
                            </td>
                            <td className="px-4 py-3 text-right text-gray-200">
                              {fmtCurrency(Number(d.amount))}
                            </td>
                            <td className="px-4 py-3 text-right text-gray-400">
                              {d.tax_rate !== null
                                ? `${(Number(d.tax_rate) * 100).toFixed(2)}%`
                                : 'SARS table'}
                            </td>
                            <td className="px-4 py-3 text-right text-red-400">
                              {d.tax_amount !== null ? fmtCurrency(Number(d.tax_amount)) : '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-300">{fmtDate(d.effective_date)}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-block px-2 py-0.5 text-xs rounded-full capitalize ${STATUS_COLORS[d.status] ?? ''}`}>
                                {d.status}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {d.status === 'pending' && (
                                <div className="flex gap-2">
                                  <button
                                    disabled={updating === d.id}
                                    onClick={() => handleStatusChange(d.id, 'approved')}
                                    className="text-xs px-2 py-1 bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 rounded transition-colors disabled:opacity-50"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    disabled={updating === d.id}
                                    onClick={() => handleStatusChange(d.id, 'cancelled')}
                                    className="text-xs px-2 py-1 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded transition-colors disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Calculator sidebar — 1/4 width */}
            <div className="xl:col-span-1">
              <LumpSumCalculator />
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
