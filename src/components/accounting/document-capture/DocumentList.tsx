import Link from 'next/link';
import { FileText, Loader2, AlertCircle, Eye, ChevronRight } from 'lucide-react';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { CapturedDocument } from '@/modules/accounting/types/documentCapture.types';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-amber-500/20 text-amber-400',
    reviewed: 'bg-blue-500/20 text-blue-400',
    matched: 'bg-teal-500/20 text-teal-400',
    rejected: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}

interface Props {
  documents: CapturedDocument[];
  total: number;
  isLoading: boolean;
  error: string;
  statusFilter: string;
  onStatusFilterChange: (v: string) => void;
}

export function DocumentList({ documents, total, isLoading, error, statusFilter, onStatusFilterChange }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--ff-border-light)] flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
          Captured Documents
          {total > 0 && <span className="text-sm font-normal text-[var(--ff-text-tertiary)] ml-2">({total})</span>}
        </h2>
        <select value={statusFilter} onChange={(e) => onStatusFilterChange(e.target.value)} className="ff-select text-sm">
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="reviewed">Reviewed</option>
          <option value="matched">Matched</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 text-teal-500 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 justify-center py-12 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : documents.length === 0 ? (
        <div className="text-center py-12 text-[var(--ff-text-tertiary)] text-sm">
          No documents captured yet. Upload a PDF above to get started.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">File</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Vendor</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Reference</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)]">Total</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)]">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Uploaded</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ff-border-light)]">
              {documents.map((doc) => (
                <tr key={doc.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                      <span className="text-[var(--ff-text-primary)] font-medium truncate max-w-[200px]">{doc.fileName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{doc.documentType || '-'}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-primary)]">{doc.vendorName || '-'}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDate(doc.documentDate)}</td>
                  <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">{doc.referenceNumber || '-'}</td>
                  <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(doc.totalAmount ?? 0)}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={doc.status} /></td>
                  <td className="px-4 py-3 text-[var(--ff-text-tertiary)] text-xs">{formatDate(doc.createdAt)}</td>
                  <td className="px-4 py-3">
                    <Link href={`/accounting/document-capture/${doc.id}`} className="inline-flex items-center gap-1 text-teal-500 hover:text-teal-400 text-xs">
                      <Eye className="h-3.5 w-3.5" />
                      View
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
