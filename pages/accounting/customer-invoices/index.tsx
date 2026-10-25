/**
 * Customer Tax Invoices - Accounting view
 * Sage equivalent: Customers > Tax Invoices
 * Lists all customer invoices across projects with GL posting status.
 *
 * 2026-04-27: Added AR aging column (aging_bucket + days_overdue from server)
 * and ARFilters chip strip. Aging filter persists in URL (?aging=...).
 *
 * 2026-09-23: Sage-style filters — customer, invoice-date period, status,
 * search and aging, all in the URL (see customer-invoices/listQuery) and
 * shown as removable chips. The CSV export carries the same filters.
 */

import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, AlertCircle, Plus, AlertTriangle, CheckCircle, CircleDollarSign } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { KpiStrip, PageHeader } from '@/components/ui';
import Link from 'next/link';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { ARFilterBar } from '@/components/accounting/customer-invoices/ARFilterBar';
import { CustomerInvoiceTable, type CustomerInvoiceRow } from '@/components/accounting/customer-invoices/CustomerInvoiceTable';
import { useCustomerInvoiceListState } from '@/components/accounting/customer-invoices/useCustomerInvoiceListState';
import { arFiltersToApiParams } from '@/components/accounting/customer-invoices/listQuery';

const LIMIT = 25;

export default function CustomerInvoicesPage() {
  const state = useCustomerInvoiceListState();
  const { filters, hydrated, nameCustomer } = state;
  const [invoices, setInvoices] = useState<CustomerInvoiceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!hydrated) return;
    let live = true;
    setIsLoading(true);
    setError('');
    const params = new URLSearchParams({ ...arFiltersToApiParams(filters), page: String(filters.page), limit: String(LIMIT) });
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customer-invoices-list?${params}`);
        await assertOk(res, 'Could not load the customer invoices - try again');
        const json = await res.json() as { data?: { invoices?: CustomerInvoiceRow[]; total?: number } };
        if (!live) return;
        const rows = json.data?.invoices ?? [];
        setInvoices(rows);
        setTotal(json.data?.total ?? 0);
        // A deep link carries only the customer id; the rows carry its name.
        if (filters.customerId && rows[0]?.client_name) nameCustomer(filters.customerId, rows[0].client_name);
      } catch (err) {
        if (!live) return;
        log.warn('Customer invoice list failed to load', { error: err }, 'customer-invoices');
        setInvoices([]);
        setTotal(0);
        setError(apiErrorMessage(err, 'Could not load the customer invoices - try again'));
      } finally {
        if (live) setIsLoading(false);
      }
    })();
    return () => { live = false; };
  }, [hydrated, filters, nameCustomer]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title="Tax Invoices"
          subtitle="Customer invoices across all projects"
          chipColor="bg-blue-500/10 text-blue-700 dark:text-blue-400"
          className="mb-0"
          actions={
            <>
              <ExportCSVButton endpoint="/api/accounting/customer-invoices-export" filenamePrefix="customer-invoices" params={arFiltersToApiParams(filters)} label="Export CSV" />
              <Link href="/accounting/customer-invoices/new" className="flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm">
                <Plus className="h-4 w-4" /> New Invoice
              </Link>
            </>
          }
        />

        <div className="p-6">
          {/* KPI strip */}
          {!isLoading && invoices.length > 0 && (() => {
            const visTotal = invoices.reduce((s, i) => s + Number(i.total_amount || 0), 0);
            const visOutstanding = invoices.reduce((s, i) => s + (Number(i.total_amount || 0) - Number(i.amount_paid || 0)), 0);
            const visOverdue = invoices.filter(i => i.status === 'overdue').length;
            const fmt = (n: number) => 'R ' + new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 }).format(n);
            return (
              <KpiStrip items={[
                { label: 'Total Invoices', value: total, icon: FileText, tone: 'info' },
                { label: 'Visible Value', value: fmt(visTotal), sub: `${invoices.length} on this page`, icon: CircleDollarSign, tone: 'neutral' },
                { label: 'Outstanding', value: fmt(visOutstanding), icon: CheckCircle, tone: 'warning' },
                { label: 'Overdue', value: visOverdue, sub: visOverdue === 0 ? 'All on time' : 'Need follow-up', icon: AlertTriangle, tone: visOverdue > 0 ? 'danger' : 'success' },
              ]} />
            );
          })()}

          <ARFilterBar state={state} total={isLoading ? null : total} />

          {/* Content */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : invoices.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No customer invoices found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Customer invoices are created from project billing</p>
            </div>
          ) : (
            <CustomerInvoiceTable invoices={invoices} page={filters.page} limit={LIMIT} total={total} onPage={state.setPage} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
