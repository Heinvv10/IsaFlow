/**
 * Storage statistics table for the Data Archiving page.
 */

import { Loader2 } from 'lucide-react';
import type { StorageStats } from '@/modules/accounting/services/dataArchivingService';

const TABLE_LABELS: Record<string, string> = {
  gl_journal_entries: 'GL Journal Entries',
  gl_journal_lines: 'GL Journal Lines',
  bank_transactions: 'Bank Transactions',
  customer_invoices: 'Customer Invoices',
  supplier_invoices: 'Supplier Invoices',
};

interface Props {
  stats: StorageStats[];
  loading: boolean;
  totalRows: number;
}

export function ArchiveStorageStats({ stats, loading, totalRows }: Props) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading statistics...
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border)]">
            {['Table', 'Row Count', 'Oldest Record', 'Newest Record'].map((h, i) => (
              <th key={h} className={`pb-2 ${i === 0 ? 'text-left' : 'text-right'} font-semibold text-[var(--ff-text-muted)]`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border)]">
          {stats.map((s) => (
            <tr key={s.tableName}>
              <td className="py-2.5 font-medium text-[var(--ff-text-primary)]">{TABLE_LABELS[s.tableName] ?? s.tableName}</td>
              <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">{s.rowCount.toLocaleString()}</td>
              <td className="py-2.5 text-right text-[var(--ff-text-muted)]">{s.oldestDate ?? '—'}</td>
              <td className="py-2.5 text-right text-[var(--ff-text-muted)]">{s.newestDate ?? '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-[var(--ff-border)]">
            <td className="pt-3 font-bold text-[var(--ff-text-primary)]">Total</td>
            <td className="pt-3 text-right font-bold text-[var(--ff-text-primary)]">{totalRows.toLocaleString()}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
