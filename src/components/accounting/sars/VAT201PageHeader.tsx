/** VAT201 page header: title, period locks link and the CSV export. */
import Link from 'next/link';
import { FileText, Download, ChevronLeft, ShieldCheck } from 'lucide-react';

export function VAT201PageHeader({ canExport, onExport }: { canExport: boolean; onExport: () => void }) {
  return (
  <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Link href="/accounting/sars" aria-label="Back to SARS compliance" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-6 w-6 text-teal-500" /></div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT201 Return</h1>
          <p className="text-sm text-[var(--ff-text-secondary)]">SARS Value-Added Tax Declaration</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/accounting/sars/vat-locks" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30">
          <ShieldCheck className="h-4 w-4" /> Period Locks
        </Link>
        {canExport && (
          <button onClick={onExport} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30">
            <Download className="h-4 w-4" /> Export CSV
          </button>
        )}
      </div>
    </div>
  </div>
  );
}
