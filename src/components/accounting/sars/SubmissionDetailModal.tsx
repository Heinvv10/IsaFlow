/**
 * Modal showing full detail of a SARS submission. Extracted from
 * pages/accounting/sars/submissions.tsx to keep the page under the
 * 300-line file budget.
 */

import { useEffect, useId } from 'react';
import { X, CheckCircle2, Clock, XCircle, AlertTriangle } from 'lucide-react';
import { formatDate } from '@/utils/formatters';

export interface SubmissionDetail {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  formData: Record<string, unknown>;
  submissionReference: string | null;
  submittedAt: string | null;
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

function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { icon: typeof CheckCircle2; className: string }> = {
    submitted: { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    accepted:  { icon: CheckCircle2, className: 'bg-emerald-500/10 text-emerald-400' },
    draft:     { icon: Clock,        className: 'bg-amber-500/10 text-amber-400' },
    generated: { icon: Clock,        className: 'bg-blue-500/10 text-blue-400' },
    rejected:  { icon: XCircle,      className: 'bg-red-500/10 text-red-400' },
  };
  const cfg = configs[status] || { icon: AlertTriangle, className: 'bg-gray-500/10 text-gray-400' };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.className}`}>
      <Icon className="h-3 w-3" /> {status}
    </span>
  );
}

interface SubmissionDetailModalProps {
  detail: SubmissionDetail | null;
  onClose: () => void;
}

export function SubmissionDetailModal({ detail, onClose }: SubmissionDetailModalProps) {
  const titleId = useId();
  const isOpen = detail !== null;

  // Escape closes the modal — keyboard parity with ConfirmDialog and the AFS
  // create modal. The hook always runs (rules of hooks); the listener is
  // only attached when the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!detail) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] w-full max-w-2xl mx-4 max-h-[80vh] overflow-auto"
      >
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between sticky top-0 bg-[var(--ff-bg-secondary)]">
          <h3 id={titleId} className="text-lg font-semibold text-[var(--ff-text-primary)]">
            {detail.formType} — {formatDate(detail.periodStart)} to {formatDate(detail.periodEnd)}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Status</p>
              <StatusBadge status={detail.status} />
            </div>
            <div>
              <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">SARS Reference</p>
              <p className="text-[var(--ff-text-primary)] font-mono">{detail.submissionReference || '—'}</p>
            </div>
            <div>
              <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Submitted</p>
              <p className="text-[var(--ff-text-secondary)]">
                {detail.submittedAt ? formatDateTime(detail.submittedAt) : '—'}
              </p>
            </div>
            <div>
              <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Created</p>
              <p className="text-[var(--ff-text-secondary)]">{formatDateTime(detail.createdAt)}</p>
            </div>
          </div>

          {detail.notes && (
            <div>
              <p className="text-[var(--ff-text-tertiary)] text-xs mb-1">Notes</p>
              <p className="text-[var(--ff-text-secondary)] text-sm">{detail.notes}</p>
            </div>
          )}

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
  );
}

function VAT201Detail({ data }: { data: Record<string, unknown> }) {
  const fields = [
    { key: 'field1_standardRatedSupplies',     label: '1. Standard-rated supplies' },
    { key: 'field2_zeroRatedSupplies',         label: '2. Zero-rated supplies' },
    { key: 'field3_exemptSupplies',            label: '3. Exempt supplies' },
    { key: 'field4_totalImports',              label: '4. Total imports' },
    { key: 'field5_outputVAT',                 label: '5. Output VAT' },
    { key: 'field6_capitalGoods',              label: '6. Input VAT — Capital goods' },
    { key: 'field7_otherGoods',                label: '7. Input VAT — Other goods' },
    { key: 'field8_services',                  label: '8. Input VAT — Services' },
    { key: 'field9_imports',                   label: '9. Input VAT — Imports' },
    { key: 'field10_totalInputVAT',            label: '10. Total input VAT' },
    { key: 'field11_vatPayableOrRefundable',   label: '11. VAT payable/(refundable)' },
  ];
  return (
    <div className="space-y-1 text-sm">
      {fields.map((f) => (
        <div key={f.key} className="flex justify-between py-1">
          <span className="text-[var(--ff-text-secondary)]">{f.label}</span>
          <span className="text-[var(--ff-text-primary)] font-medium">{fmt(Number(data[f.key]) || 0)}</span>
        </div>
      ))}
    </div>
  );
}

function EMP201Detail({ data }: { data: Record<string, unknown> }) {
  const fields = [
    { key: 'employeeCount',            label: 'Employees',            isCurrency: false },
    { key: 'totalTaxableRemuneration', label: 'Total remuneration',   isCurrency: true  },
    { key: 'totalPAYE',                label: 'PAYE',                 isCurrency: true  },
    { key: 'totalUIF',                 label: 'Total UIF',            isCurrency: true  },
    { key: 'totalSDL',                 label: 'SDL',                  isCurrency: true  },
    { key: 'totalDeductions',          label: 'Total payable',        isCurrency: true  },
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
