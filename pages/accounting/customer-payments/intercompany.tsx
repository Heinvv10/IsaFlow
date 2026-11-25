/**
 * /accounting/customer-payments/intercompany — Sales > Intercompany Payments (intercompany F, cash mode). The RECEIVER's "Payments from your group": the
 * payments a group company made from its bank on bills linked to this company's invoices, each with the database's state word; match one to a
 * receipt you already have or draft a receipt for it (nothing posts until a receipt is confirmed), reject, dismiss, discard a draft. Below it the
 * PAYER's "Paid with no payment message". Behind the dark flag intercompany_loan_clearing (the nav hides the link; the routes refuse).
 */
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Link2, X } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { PaymentInboxSection } from '@/components/accounting/intercompany/payments/PaymentInboxSection';
import { UnsentPaymentsSection } from '@/components/accounting/intercompany/payments/UnsentPaymentsSection';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import type { InboxFilter } from '@/modules/accounting/services/intercompany/inboxTypes';

type Notice = { msg: string; ok: boolean };

export default function IntercompanyPaymentsPage() {
  const mayWrite = canWrite(useCompany().companyRole);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [notice, setNotice] = useState<Notice | null>(null);
  const afterDelay = useTimeoutOnce();
  const say = useCallback((n: Notice) => { setNotice(n); afterDelay(() => setNotice(null), 8000); }, [afterDelay]);
  return (
    <AppLayout>
      {notice && (
        <div role={notice.ok ? 'status' : 'alert'} className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
          notice.ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'}`}>
          <span className="flex-1 text-sm">{notice.msg}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader icon={Link2} title="Intercompany payments" className="mb-0"
          subtitle="Payments between your group companies on a cash connection. Matching or drafting a receipt posts nothing; a draft is confirmed like any receipt."
          actions={<Link href="/accounting/settings/intercompany" className="px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken">Connections</Link>} />
        <div className="p-6 space-y-4">
          <div className="flex gap-2" role="group" aria-label="Show">
            {(['open', 'handled'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-sm rounded-lg border ${filter === f ? 'bg-brand-600 text-white border-brand-600' : 'border-line text-ink hover:bg-surface-sunken'}`}>
                {f === 'open' ? 'Needs you' : 'Handled'}
              </button>
            ))}
          </div>
          <PaymentInboxSection filter={filter} canWrite={mayWrite} onNotice={say} />
          <UnsentPaymentsSection />
        </div>
      </div>
    </AppLayout>
  );
}
