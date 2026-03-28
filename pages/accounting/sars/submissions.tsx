/**
 * SARS Submission History Page
 * Table of all past submissions with type, period, status, reference, and details.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Loader2, ChevronLeft,
  CheckCircle2, Clock, XCircle, AlertTriangle,
  Eye, X,
} from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Submission {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  formData: Record<string, unknown>;
  submissionReference: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const formatDateTime = (d: string) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

const statusBadge = (status: string) => {
  const configs: Record<string, { icon: typeof CheckCircle2; className: string }> = {
    submitted: { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    accepted: { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    draft: { icon: Clock, className: 'bg-amber-500/10 text-amber-400' },
    generated: { icon: Clock, className: 'bg-blue-500/10 text-blue-400' },
    rejected: { icon: XCircle, className: 'bg-red-500/10 text-red-400' },
  };
  const cfg = configs[status] || { icon: AlertTriangle, className: 'bg-gray-500/10 text-gray-400' };
  const Icon = cfg.icon;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.className}`}>
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
};

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [detail, setDetail] = useState<Submission | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const typeParam = filter !== 'all' ? `?type=${filter}` : '';
      const res = await apiFetch(
        `/api/accounting/sars/sars-submissions${typeParam}`,
        { credentials: 'include' }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      setSubmissions(json.data?.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load submissions');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const viewDetail = async (id: string) => {
    try {
      const res = await apiFetch('/api/accounting/sars/sars-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id, action: 'get' }),
      });
      const json = await res.json();
      if (json.data) {
        setDetail(json.data);
      }
    } catch {
      // Fallback to local data
      const sub = submissions.find((s) => s.id === id);
      if (sub) setDetail(sub);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/accounting/sars"
              className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-purple-500/10">
              <FileText className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Submission History</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                All SARS eFiling submissions and their statuses
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          {/* Filter Tabs */}
          <div className="flex gap-1 bg-[var(--ff-bg-secondary)] rounded-lg p-1 w-fit border border-[var(--ff-border-light)]">
            {['all', 'VAT201', 'EMP201', 'EMP501', 'IRP5'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-teal-600 text-white'
                    : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                {f === 'all' ? 'All' : f}
              </button>
            ))}
          </div>

          {/* Submissions Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">SARS Reference</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                      Loading submissions...
                    </td>
                  </tr>
                )}
                {!loading && submissions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No submissions found. Generate a VAT201 or EMP201 to create your first submission.
                    </td>
                  </tr>
                )}
                {submissions.map((sub) => (
                  <tr
                    key={sub.id}
                    className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">
                        {sub.formType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">
                      {formatDate(sub.periodStart)} — {formatDate(sub.periodEnd)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(sub.status)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">
                      {sub.submissionReference || '—'}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {sub.submittedAt ? formatDateTime(sub.submittedAt) : '—'}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {formatDate(sub.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => viewDetail(sub.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-teal-500 hover:text-teal-400 hover:bg-teal-500/10"
                      >
                        <Eye className="h-3 w-3" /> View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail Modal */}
        {detail && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] w-full max-w-2xl mx-4 max-h-[80vh] overflow-auto">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between sticky top-0 bg-[var(--ff-bg-secondary)]">
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                  {detail.formType} — {formatDate(detail.periodStart)} to {formatDate(detail.periodEnd)}
                </h3>
                <button
                  onClick={() => setDetail(null)}
                  className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Status</p>
                    {statusBadge(detail.status)}
                  </div>
                  <div>
                    <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">SARS Reference</p>
                    <p className="text-[var(--ff-text-primary)] font-mono">
                      {detail.submissionReference || '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Submitted</p>
                    <p className="text-[var(--ff-text-secondary)]">
                      {detail.submittedAt ? formatDateTime(detail.submittedAt) : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Created</p>
                    <p className="text-[var(--ff-text-secondary)]">
                      {formatDateTime(detail.createdAt)}
                    </p>
                  </div>
                </div>

                {detail.notes && (
                  <div>
                    <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Notes</p>
                    <p className="text-[var(--ff-text-secondary)] text-sm">{detail.notes}</p>
                  </div>
                )}

                {/* Form Data */}
                <div>
                  <p className="text-[var(--ff-text-tertiary)] text-xs mb-2">Form Data</p>
                  <div className="bg-[var(--ff-bg-primary)] rounded-lg p-4 border border-[var(--ff-border-light)]">
                    {detail.formType === 'VAT201' && <VAT201Detail data={detail.formData} />}
                    {detail.formType === 'EMP201' && <EMP201Detail data={detail.formData} />}
                    {detail.formType !== 'VAT201' && detail.formType !== 'EMP201' && (
                      <pre className="text-xs text-[var(--ff-text-secondary)] overflow-auto">
                        {JSON.stringify(detail.formData, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function VAT201Detail({ data }: { data: Record<string, unknown> }) {
  const fields = [
    { key: 'field1_standardRatedSupplies', label: '1. Standard-rated supplies' },
    { key: 'field2_zeroRatedSupplies', label: '2. Zero-rated supplies' },
    { key: 'field3_exemptSupplies', label: '3. Exempt supplies' },
    { key: 'field4_totalImports', label: '4. Total imports' },
    { key: 'field5_outputVAT', label: '5. Output VAT' },
    { key: 'field6_capitalGoods', label: '6. Input VAT — Capital goods' },
    { key: 'field7_otherGoods', label: '7. Input VAT — Other goods' },
    { key: 'field8_services', label: '8. Input VAT — Services' },
    { key: 'field9_imports', label: '9. Input VAT — Imports' },
    { key: 'field10_totalInputVAT', label: '10. Total input VAT' },
    { key: 'field11_vatPayableOrRefundable', label: '11. VAT payable/(refundable)' },
  ];

  return (
    <div className="space-y-1 text-sm">
      {fields.map((f) => (
        <div key={f.key} className="flex justify-between py-1">
          <span className="text-[var(--ff-text-secondary)]">{f.label}</span>
          <span className="text-[var(--ff-text-primary)] font-medium">
            {fmt(Number(data[f.key]) || 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

function EMP201Detail({ data }: { data: Record<string, unknown> }) {
  const fields = [
    { key: 'employeeCount', label: 'Employees', isCurrency: false },
    { key: 'totalTaxableRemuneration', label: 'Total remuneration', isCurrency: true },
    { key: 'totalPAYE', label: 'PAYE', isCurrency: true },
    { key: 'totalUIF', label: 'Total UIF', isCurrency: true },
    { key: 'totalSDL', label: 'SDL', isCurrency: true },
    { key: 'totalDeductions', label: 'Total payable', isCurrency: true },
  ];

  return (
    <div className="space-y-1 text-sm">
      {fields.map((f) => (
        <div key={f.key} className="flex justify-between py-1">
          <span className="text-[var(--ff-text-secondary)]">{f.label}</span>
          <span className="text-[var(--ff-text-primary)] font-medium">
            {f.isCurrency ? fmt(Number(data[f.key]) || 0) : String(data[f.key] || 0)}
          </span>
        </div>
      ))}
    </div>
  );
}
