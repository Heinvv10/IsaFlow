/**
 * VAT period locks — page shell.
 */
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { NotVatRegisteredNotice } from '@/components/accounting/NotVatRegisteredNotice';
import { VatPeriodLocksPanel } from '@/components/accounting/sars/VatPeriodLocksPanel';

export default function VatPeriodLocksPage() {
  const { isRegistered, known } = useVatRegistration();

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/sars/vat201" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
              <ChevronLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10"><ShieldCheck className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT Period Locks</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Filed VAT201 periods and their lock history</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {known && !isRegistered && <NotVatRegisteredNotice surface="VAT period locks" />}
          {known && isRegistered && <VatPeriodLocksPanel />}
        </div>
      </div>
    </AppLayout>
  );
}
