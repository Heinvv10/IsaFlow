/**
 * LoanOverviewTab — key terms grid + status editor for the loan detail page.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { Loan, fmt, fmtDate, fmtPct, PRODUCT_LABELS } from './types';
import { LoanStatusBadge } from './LoanStatusBadge';

interface Props {
  loan: Loan;
  onRefresh: () => void;
}

type LoanStatus = 'active' | 'closed' | 'written_off';

export function LoanOverviewTab({ loan, onRefresh }: Props) {
  const [status, setStatus] = useState<LoanStatus>(loan.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleStatusChange = async (newStatus: LoanStatus) => {
    if (newStatus === loan.status) return;
    setError('');
    setBusy(true);
    try {
      const res = await apiFetch(`/api/accounting/loans/${loan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to update status');
      setStatus(newStatus);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
      setStatus(loan.status);
    } finally {
      setBusy(false);
    }
  };

  const rateLabel = loan.rateMode === 'FIXED'
    ? fmtPct(loan.fixedRate ?? 0)
    : `Prime ${loan.rateMode === 'PRIME_PLUS' ? '+' : '−'} ${fmtPct(loan.margin)}`;

  const terms: Array<{ label: string; value: string }> = [
    { label: 'Reference', value: loan.reference || '—' },
    { label: 'Product', value: PRODUCT_LABELS[loan.product ?? ''] || loan.product || '—' },
    { label: 'Currency', value: loan.currency },
    { label: 'Principal', value: fmt(loan.principal) },
    { label: 'Residual', value: fmt(loan.residual) },
    { label: 'Rate', value: rateLabel },
    { label: 'Rate Mode', value: loan.rateMode.replace(/_/g, ' ') },
    { label: 'Reprice Mode', value: loan.repriceMode.replace(/_/g, ' ') },
    { label: 'Term', value: `${loan.termMonths} months` },
    { label: 'Start Date', value: fmtDate(loan.startDate) },
    { label: 'Day Count', value: loan.dayCount },
    { label: 'NCA Compliant', value: loan.ncaCompliant ? 'Yes' : 'No' },
    { label: 'Skip Mode', value: loan.skipMode.replace(/_/g, ' ') },
    { label: 'Lump Mode', value: loan.lumpMode.replace(/_/g, ' ') },
    { label: 'Skip Months', value: loan.recurringSkipMonths.length > 0
      ? loan.recurringSkipMonths.map(m => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]).join(', ')
      : 'None'
    },
  ];

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--ff-text-secondary)]">Status:</span>
          <LoanStatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={e => handleStatusChange(e.target.value as LoanStatus)}
            disabled={busy}
            className="ff-select text-sm"
          >
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="written_off">Written Off</option>
          </select>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />}
        </div>
        {loan.description && (
          <p className="text-sm text-[var(--ff-text-secondary)] ml-auto">{loan.description}</p>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {terms.map(({ label, value }) => (
          <div key={label} className="bg-[var(--ff-bg-primary)] rounded-lg border border-[var(--ff-border-light)] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--ff-text-tertiary)] mb-1">
              {label}
            </p>
            <p className="text-sm font-medium text-[var(--ff-text-primary)]">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
