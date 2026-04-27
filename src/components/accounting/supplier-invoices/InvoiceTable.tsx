/**
 * Invoice list table with checkbox selection, sortable columns, and a
 * bottom pagination strip.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight,
  ArrowUp, ArrowDown, ArrowUpDown, FileText,
  Paperclip, AlertTriangle, CreditCard,
} from 'lucide-react';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { StatusPill } from '@/components/ui';
import { PER_PAGE_OPTIONS, type PerPage, type SortKey, type SortOrder } from './listTypes';

interface Props {
  invoices: SupplierInvoice[];
  selected: ReadonlySet<string>;
  toggleRow: (id: string) => void;
  toggleAll: () => void;
  sort: SortKey;
  sortOrder: SortOrder;
  onSort: (col: SortKey) => void;
  page: number;
  perPage: PerPage;
  total: number;
  onPage: (p: number) => void;
  onPerPage: (n: PerPage) => void;
  filtersActive: boolean;
}

export function InvoiceTable({
  invoices, selected, toggleRow, toggleAll,
  sort, sortOrder, onSort,
  page, perPage, total, onPage, onPerPage, filtersActive,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const visibleStart = total === 0 ? 0 : (page - 1) * perPage + 1;
  const visibleEnd = Math.min(page * perPage, total);

  if (invoices.length === 0) {
    return (
      <div className="p-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
          <FileText className="w-7 h-7 text-slate-500 dark:text-slate-400" />
        </div>
        <h3 className="text-base font-semibold text-slate-900 dark:text-white">No invoices found</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {filtersActive ? 'Try clearing some filters' : 'Record your first supplier invoice'}
        </p>
        {!filtersActive && (
          <Link href="/accounting/supplier-invoices/new" className="inline-block mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">
            New Invoice
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
          <tr>
            <th className="px-4 py-3 w-10">
              <input
                type="checkbox"
                checked={selected.size === invoices.length && invoices.length > 0}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                aria-label="Select all"
              />
            </th>
            <SortHeader col="invoice_number" label="Invoice #" sort={sort} order={sortOrder} onClick={onSort} />
            <SortHeader col="supplier_name" label="Supplier" sort={sort} order={sortOrder} onClick={onSort} />
            <SortHeader col="reference" label="Reference" sort={sort} order={sortOrder} onClick={onSort} />
            <SortHeader col="invoice_date" label="Date" sort={sort} order={sortOrder} onClick={onSort} />
            <SortHeader col="total_amount" label="Total" sort={sort} order={sortOrder} onClick={onSort} align="right" />
            <SortHeader col="balance" label="Outstanding" sort={sort} order={sortOrder} onClick={onSort} align="right" />
            <SortHeader col="status" label="Status" sort={sort} order={sortOrder} onClick={onSort} />
            <th className="px-3 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap">Signals</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {invoices.map((inv) => {
            const outstanding = inv.balance ?? (inv.totalAmount - (inv.amountPaid || 0));
            const isSelected = selected.has(inv.id);
            return (
              <tr key={inv.id} className={`transition-colors ${isSelected ? 'bg-amber-500/5' : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'}`}>
                <td className="px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleRow(inv.id)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                    aria-label={`Select invoice ${inv.invoiceNumber}`}
                  />
                </td>
                <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">
                  <Link href={`/accounting/supplier-invoices/${inv.id}`} className="hover:underline">
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{inv.supplierName || '—'}</td>
                <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title={inv.reference}>{inv.reference || '—'}</td>
                <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{formatDate(inv.invoiceDate)}</td>
                <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{formatCurrency(inv.totalAmount)}</td>
                <td className={`px-5 py-3.5 text-right font-mono font-semibold ${outstanding > 0 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {formatCurrency(outstanding)}
                </td>
                <td className="px-5 py-3.5"><StatusPill status={inv.status} /></td>
                <td className="px-3 py-3.5">
                  <SignalBadges inv={inv} />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <Link href={`/accounting/supplier-invoices/${inv.id}`} className="text-slate-500 dark:text-slate-400 hover:text-amber-500 transition-colors">
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30 text-sm">
        <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
          <span>
            Showing <span className="font-semibold text-slate-900 dark:text-white">{visibleStart}–{visibleEnd}</span> of <span className="font-semibold text-slate-900 dark:text-white">{total}</span>
          </span>
          <select
            name="perPage"
            value={perPage}
            onChange={(e) => onPerPage(Number(e.target.value) as PerPage)}
            className="px-2 py-1 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs"
          >
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <PageBtn onClick={() => onPage(1)} disabled={page === 1} label="First page"><ChevronsLeft className="h-4 w-4" /></PageBtn>
          <PageBtn onClick={() => onPage(page - 1)} disabled={page === 1} label="Previous page"><ChevronLeft className="h-4 w-4" /></PageBtn>
          <span className="px-3 text-xs text-slate-600 dark:text-slate-400">
            Page <span className="font-semibold text-slate-900 dark:text-white">{page}</span> of <span className="font-semibold text-slate-900 dark:text-white">{totalPages}</span>
          </span>
          <PageBtn onClick={() => onPage(page + 1)} disabled={page >= totalPages} label="Next page"><ChevronRight className="h-4 w-4" /></PageBtn>
          <PageBtn onClick={() => onPage(totalPages)} disabled={page >= totalPages} label="Last page"><ChevronsRight className="h-4 w-4" /></PageBtn>
        </div>
      </div>
    </>
  );
}

function SignalBadges({ inv }: { inv: SupplierInvoice }) {
  return (
    <div className="flex items-center gap-1.5 flex-nowrap">
      {inv.hasDocument !== undefined && (
        <span
          title={inv.hasDocument ? 'Document attached' : 'No document'}
          aria-label={inv.hasDocument ? 'Document attached' : 'No document'}
          className={inv.hasDocument
            ? 'text-emerald-500 dark:text-emerald-400'
            : 'text-slate-300 dark:text-slate-600'}
        >
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
        </span>
      )}
      {inv.hasPo && (
        <span
          title="Linked to purchase order"
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 leading-none"
        >
          PO
        </span>
      )}
      {inv.isPossibleDuplicate && (
        <span title="Possible duplicate invoice" aria-label="Possible duplicate">
          <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 dark:text-yellow-400" aria-hidden />
        </span>
      )}
      {inv.paymentRunEligible && (
        <span
          title="Ready for payment run"
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 leading-none"
        >
          <CreditCard className="h-2.5 w-2.5" aria-hidden />
          Pay
        </span>
      )}
    </div>
  );
}

interface SortHeaderProps {
  col: SortKey;
  label: string;
  sort: SortKey;
  order: SortOrder;
  onClick: (col: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ col, label, sort, order, onClick, align = 'left' }: SortHeaderProps) {
  const active = sort === col;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`px-5 py-3 text-${align} text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider`}>
      <button
        type="button"
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-1.5 hover:text-slate-700 dark:hover:text-slate-200 transition-colors ${active ? 'text-amber-500 dark:text-amber-400' : ''}`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </button>
    </th>
  );
}

function PageBtn({
  onClick, disabled, label, children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}
