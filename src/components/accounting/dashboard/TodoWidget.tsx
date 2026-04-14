/**
 * TodoWidget — Action Items for the accounting dashboard Overview tab.
 * Fetches from /api/accounting/dashboard-todos and renders a compact action list.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Loader2, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface OverdueInvoice {
  id: string;
  invoiceNumber: string;
  clientName: string;
  amount: number;
  daysOverdue: number;
}

interface PendingSupplierPayment {
  id: string;
  invoiceNumber: string;
  supplierName: string;
  amount: number;
  daysOverdue: number;
}

interface TodoData {
  overdueInvoices: OverdueInvoice[];
  pendingSupplierPayments: PendingSupplierPayment[];
  uncategorizedBankTxns: number;
  draftInvoices: number;
}

function fmtZAR(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

function ActionRow({
  label,
  href,
  badge,
  badgeColor = 'rose',
}: {
  label: string;
  href: string;
  badge: number;
  badgeColor?: 'rose' | 'amber' | 'blue' | 'gray';
}) {
  const badgeClasses: Record<string, string> = {
    rose: 'bg-rose-500/10 text-rose-500',
    amber: 'bg-amber-500/10 text-amber-600',
    blue: 'bg-blue-500/10 text-blue-500',
    gray: 'bg-gray-500/10 text-gray-500',
  };

  return (
    <Link
      href={href}
      className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--ff-bg-tertiary)] rounded-lg transition-colors group no-underline"
    >
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full text-xs font-semibold ${badgeClasses[badgeColor]}`}>
          {badge}
        </span>
        <span className="text-sm text-[var(--ff-text-primary)]">{label}</span>
      </div>
      <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-[var(--ff-text-secondary)] transition-colors" />
    </Link>
  );
}

function InvoiceDetailRow({ invoice }: { invoice: OverdueInvoice }) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 pl-10">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-[var(--ff-text-secondary)] truncate max-w-[140px]">{invoice.clientName}</span>
        <span className="text-xs text-[var(--ff-text-tertiary)]">#{invoice.invoiceNumber}</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs font-medium text-[var(--ff-text-primary)]">{fmtZAR(invoice.amount)}</span>
        <span className="text-xs text-rose-500 font-medium">{invoice.daysOverdue}d overdue</span>
      </div>
    </div>
  );
}

export function TodoWidget() {
  const [data, setData] = useState<TodoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/dashboard-todos');
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError('Failed to load action items');
        log.error('dashboard-todos returned error', { json }, 'accounting-ui');
      }
    } catch (err) {
      setError('Failed to load action items');
      log.error('Failed to fetch dashboard todos', { error: err }, 'accounting-ui');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const isAllClear =
    !loading &&
    !error &&
    data !== null &&
    data.overdueInvoices.length === 0 &&
    data.pendingSupplierPayments.length === 0 &&
    data.uncategorizedBankTxns === 0 &&
    data.draftInvoices === 0;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
      <div className="flex items-center gap-2 mb-3">
        <AlertCircle className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Action Items</h3>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-teal-500" />
        </div>
      )}

      {!loading && error && (
        <p className="text-sm text-rose-500 px-4 py-3">{error}</p>
      )}

      {!loading && !error && isAllClear && (
        <div className="flex items-center gap-2 px-4 py-4 text-teal-500">
          <CheckCircle2 className="h-5 w-5" />
          <span className="text-sm font-medium">All caught up!</span>
        </div>
      )}

      {!loading && !error && !isAllClear && data && (
        <div className="space-y-0.5">
          {/* Overdue customer invoices */}
          {data.overdueInvoices.length > 0 && (
            <>
              <ActionRow
                label={`${data.overdueInvoices.length} overdue invoice${data.overdueInvoices.length !== 1 ? 's' : ''}`}
                href="/accounting/customer-invoices?filter=overdue"
                badge={data.overdueInvoices.length}
                badgeColor="rose"
              />
              {data.overdueInvoices.slice(0, 3).map((inv) => (
                <InvoiceDetailRow key={inv.id} invoice={inv} />
              ))}
            </>
          )}

          {/* Pending supplier payments */}
          {data.pendingSupplierPayments.length > 0 && (
            <ActionRow
              label={`${data.pendingSupplierPayments.length} supplier payment${data.pendingSupplierPayments.length !== 1 ? 's' : ''} due`}
              href="/accounting/supplier-invoices"
              badge={data.pendingSupplierPayments.length}
              badgeColor="amber"
            />
          )}

          {/* Uncategorized bank transactions */}
          {data.uncategorizedBankTxns > 0 && (
            <ActionRow
              label={`${data.uncategorizedBankTxns} bank transaction${data.uncategorizedBankTxns !== 1 ? 's' : ''} to categorize`}
              href="/accounting/bank-transactions"
              badge={data.uncategorizedBankTxns}
              badgeColor="blue"
            />
          )}

          {/* Draft invoices */}
          {data.draftInvoices > 0 && (
            <ActionRow
              label={`${data.draftInvoices} draft invoice${data.draftInvoices !== 1 ? 's' : ''}`}
              href="/accounting/customer-invoices?filter=draft"
              badge={data.draftInvoices}
              badgeColor="gray"
            />
          )}
        </div>
      )}
    </div>
  );
}
