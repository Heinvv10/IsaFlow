/**
 * Generate Invoice from unbilled practice WIP
 * Route: /accounting/practice/generate-invoice
 */
import { FileText } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { GenerateInvoiceForm } from '@/components/accounting/practice/GenerateInvoiceForm';

export default function GenerateInvoicePage() {
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-5 w-5 text-teal-400" /></div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Generate Invoice</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Bill a client&apos;s approved, unbilled time as a draft invoice.</p>
            </div>
          </div>
        </div>
        <div className="px-6 py-6 max-w-7xl">
          <GenerateInvoiceForm />
        </div>
      </div>
    </AppLayout>
  );
}
