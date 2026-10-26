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

import { useEffect, useRef, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, AlertCircle, Plus, AlertTriangle, CheckCircle } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { KpiStrip, PageHeader } from '@/components/ui';
import Link from 'next/link';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { ARFilterBar } from '@/components/accounting/customer-invoices/ARFilterBar';
import { CustomerInvoiceTable, type CustomerInvoiceRow } from '@/components/accounting/customer-invoices/CustomerInvoiceTable';
import { useCustomerInvoiceListState } from '@/components/accounting/customer-invoices/useCustomerInvoiceListState';
import { arFiltersToApiParams } from '@/components/accounting/customer-invoices/listQuery';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { ListEmpty } from '@/components/ui/ListEmpty';
import { formatMoney } from '@/lib/money/formatMoney';
import type { AROutstandingSummary } from '@/modules/accounting/services/ar/arOutstandingService';

const LIMIT = 25;

export default function CustomerInvoicesPage() {
  const state = useCustomerInvoiceListState();
  const { filters, hydrated, nameCustomer } = state;
  const [invoices, setInvoices] = useState<CustomerInvoiceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [total, setTotal] = useState(0);
  const [arSummary, setArSummary] = useState<AROutstandingSummary | null>(null);
  const haveSummary = useRef(false);
  const filtersActive = filters.status !== 'all' || !!(filters.search || filters.customerId || filters.from || filters.to) || filters.aging.length > 0;

  useEffect(() => {
    if (!hydrated) return;
    let live = true;
    setIsLoading(true);
    setError('');
    const params = new URLSearchParams({ ...arFiltersToApiParams(filters), page: String(filters.page), limit: String(LIMIT) });
    // Company-wide tiles do not change with the page or filters: fetch them once.
    if (!haveSummary.current) params.set('summary', '1');
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/customer-invoices-list?${params}`);
        await assertOk(res, 'Could not load the customer invoices - try again');
        const json = await res.json() as { data?: { invoices?: CustomerInvoiceRow[]; total?: number; arSummary?: AROutstandingSummary } };
        if (!live) return;
        const rows = json.data?.invoices ?? [];
        setInvoices(rows);
        setTotal(json.data?.total ?? 0);
        if (json.data?.arSummary) { setArSummary(json.data.arSummary); haveSummary.current = true; }
        // A deep link carries only the customer id; the rows carry its name.
        if (filters.customerId && rows[0]?.client_name) nameCustomer(filters.customerId, rows[0].client_name);
      } catch (err) {
        if (!live) return;
        log.warn('Customer invoice list failed to load', { error: err }, 'customer-invoices');
        setInvoices([]);
        setTotal(0);
        setArSummary(null);
        haveSummary.current = false;
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
          {/* KPI strip: Outstanding and Overdue are company-wide (all invoices, not this page or filter) */}
          {!isLoading && arSummary && (() => {
            const fmt = (n: number) => formatMoney(n, { decimals: 0 });
            const { outstanding, overdueCount, overdueAmount, onDeletedAmount } = arSummary;
            return (
              <KpiStrip items={[
                { label: 'Invoices (this filter)', value: total, icon: FileText, tone: 'info' },
                { label: 'Outstanding (all invoices)', value: fmt(outstanding), sub: onDeletedAmount > 0 ? `Includes ${fmt(onDeletedAmount)} on deleted invoices with unreversed journals` : 'Open balance, company-wide', icon: CheckCircle, tone: 'warning' },
                { label: 'Overdue (all invoices)', value: overdueCount, sub: overdueCount === 0 ? 'All on time' : `${fmt(overdueAmount)} past due date`, icon: AlertTriangle, tone: overdueCount > 0 ? 'danger' : 'success' },
              ]} />
            );
          })()}

          <ARFilterBar state={state} total={isLoading ? null : total} />

          {/* Content */}
          {isLoading ? (
            <ListSkeleton label="Loading invoices" />
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : invoices.length === 0 ? (
            <ListEmpty
              filtered={filtersActive}
              onClearFilters={state.clearAll}
              page={filters.page}
              total={total}
              onFirstPage={() => state.setPage(1)}
              firstRun={{
                icon: FileText,
                title: 'No invoices yet',
                description: 'Bill your first customer and track what they owe you.',
                checklist: ['Add a customer', 'Create the invoice', 'Send it and record the payment'],
                primaryAction: { label: 'New Invoice', href: '/accounting/customer-invoices/new' },
              }}
            />
          ) : (
            <CustomerInvoiceTable invoices={invoices} page={filters.page} limit={LIMIT} total={total} onPage={state.setPage} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
