/** VAT201 page header: title, period locks link and the CSV export. */
import Link from 'next/link';
import { FileText, Download, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';

const ACTION =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-teal-500/30';

export function VAT201PageHeader({ canExport, onExport }: { canExport: boolean; onExport: () => void }) {
  return (
    <PageHeader
      icon={FileText}
      title="VAT201 Return"
      subtitle="SARS Value-Added Tax Declaration"
      breadcrumb={[{ label: 'SARS compliance', href: '/accounting/sars' }, { label: 'VAT201 Return' }]}
      className="mb-0"
      actions={
        <>
          <Link href="/accounting/sars/vat-locks" className={ACTION}>
            <ShieldCheck className="h-4 w-4" /> Period Locks
          </Link>
          {canExport && (
            <button onClick={onExport} className={ACTION}>
              <Download className="h-4 w-4" /> Export CSV
            </button>
          )}
        </>
      }
    />
  );
}
