/** EMP201 page header: back link, title and the CSV export (moved from pages/accounting/sars/emp201.tsx). */
import Link from 'next/link';
import { ChevronLeft, Download, Users } from 'lucide-react';

export function Emp201PageHeader({ canExport, onExport }: { canExport: boolean; onExport: () => void }) {
  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/accounting/sars"
            aria-label="Back to SARS compliance"
            className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </Link>
          <div className="p-2 rounded-lg bg-blue-500/10">
            <Users className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">EMP201 Return</h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">
              Monthly employer declaration — PAYE, UIF and SDL
            </p>
          </div>
        </div>
        {canExport && (
          <button
            onClick={onExport}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        )}
      </div>
    </div>
  );
}
