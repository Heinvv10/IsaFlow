/**
 * Tax Directives Page
 * SARS lump sum, retirement, severance & death directives.
 * Route: /payroll/tax-directives
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, AlertCircle, Plus, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { CreateTaxDirectiveModal } from '@/components/payroll/TaxDirectiveComponents';

type DirectiveType = 'lump_sum' | 'retirement' | 'severance' | 'death';
type DirectiveStatus = 'pending' | 'approved' | 'expired' | 'cancelled';
type StatusFilter = 'all' | DirectiveStatus;

interface TaxDirective {
  id: string;
  employeeName: string;
  employeeTaxNumber: string | null;
  directiveType: DirectiveType;
  amount: number;
  taxRate: number | null;
  effectiveDate: string;
  status: DirectiveStatus;
}

const TYPE_LABELS: Record<DirectiveType, string> = {
  lump_sum: 'Lump Sum',
  retirement: 'Retirement',
  severance: 'Severance',
  death: 'Death',
};

const STATUS_LABELS: Record<DirectiveStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const STATUS_COLOURS: Record<DirectiveStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400',
  approved: 'bg-teal-500/20 text-teal-400',
  expired: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  cancelled: 'bg-red-500/20 text-red-400',
};

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'expired', label: 'Expired' },
  { value: 'cancelled', label: 'Cancelled' },
];

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const TH = 'text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';
const TH_R = 'text-right py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';

function StatusBadge({ status }: { status: DirectiveStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export default function TaxDirectivesPage() {
  const [directives, setDirectives] = useState<TaxDirective[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showModal, setShowModal] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadDirectives = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await apiFetch(`/api/accounting/tax-directives?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const payload = json.data ?? json;
      setDirectives(Array.isArray(payload) ? payload : []);
    } catch {
      setError('Failed to load tax directives');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    void loadDirectives();
  }, [loadDirectives]);

  const handleStatusUpdate = async (id: string, status: DirectiveStatus) => {
    setActionLoading(id);
    // Optimistic update
    setDirectives(prev =>
      prev.map(d => (d.id === id ? { ...d, status } : d)),
    );
    try {
      const res = await apiFetch(`/api/accounting/tax-directives/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        // Revert optimistic update on failure
        void loadDirectives();
      }
    } catch {
      void loadDirectives();
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-5 w-5 text-teal-400" /></div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Tax Directives</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">SARS lump sum, retirement, severance &amp; death directives</p>
              </div>
            </div>
            <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors">
              <Plus className="h-4 w-4" />New Directive
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          {/* Filters */}
          <div className="flex items-center gap-3 mb-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by employee name..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-72 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as StatusFilter)}
              className="py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {STATUS_FILTER_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {directives.length} directive{directives.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* States */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : directives.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No tax directives</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                {search || statusFilter !== 'all'
                  ? 'Try adjusting your search or filter'
                  : 'Create your first SARS tax directive to get started'}
              </p>
              {!search && statusFilter === 'all' && (
                <button
                  onClick={() => setShowModal(true)}
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  New Directive
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className={TH}>Employee</th>
                    <th className={TH}>Type</th>
                    <th className={TH}>Effective</th>
                    <th className={TH_R}>Amount (R)</th>
                    <th className={TH_R}>Tax Rate %</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {directives.map(d => (
                    <tr
                      key={d.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-teal-500/[0.04] transition-colors"
                    >
                      <td className="py-3 px-4">
                        <span className="font-medium text-[var(--ff-text-primary)]">
                          {d.employeeName}
                        </span>
                        {d.employeeTaxNumber && (
                          <div className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
                            {d.employeeTaxNumber}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                        {TYPE_LABELS[d.directiveType]}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                        {d.effectiveDate}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">
                        {fmtCurrency(d.amount)}
                      </td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">
                        {d.taxRate != null ? `${(d.taxRate * 100).toFixed(2)}%` : '—'}
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          {d.status === 'pending' && (
                            <button
                              disabled={actionLoading === d.id}
                              onClick={() => void handleStatusUpdate(d.id, 'approved')}
                              className="text-xs text-teal-400 hover:text-teal-300 disabled:opacity-50 transition-colors"
                            >
                              Approve
                            </button>
                          )}
                          {(d.status === 'pending' || d.status === 'approved') && (
                            <button
                              disabled={actionLoading === d.id}
                              onClick={() => void handleStatusUpdate(d.id, 'cancelled')}
                              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <CreateTaxDirectiveModal
          onClose={() => setShowModal(false)}
          onCreated={() => void loadDirectives()}
        />
      )}
    </AppLayout>
  );
}
