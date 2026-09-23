/**
 * "View all invoices" from an aging drill-down panel: the customer's (or
 * supplier's) full invoice list, filtered by the list pages' own URL params.
 * The panel shows only the invoices open at the as-at date; this is every
 * invoice, paid or not, so the user can page through the account's history.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { INVOICE_LINK } from './agingPanelFormat';

export type InvoiceLedger = 'customer' | 'supplier';

export function allInvoicesHref(ledger: InvoiceLedger, entityId: string): string {
  // Only the id: each list names the entity from its own rows, never from the URL.
  return ledger === 'customer'
    ? `/accounting/customer-invoices?${new URLSearchParams({ customer: entityId })}`
    : `/accounting/supplier-invoices?${new URLSearchParams({ supplier_id: entityId })}`;
}

interface Props {
  ledger: InvoiceLedger;
  entityId: string;
  entityName: string;
  colSpan: number;
}

export function ViewAllInvoicesFooter({ ledger, entityId, entityName, colSpan }: Props) {
  return (
    <tfoot>
      <tr>
        <td colSpan={colSpan} className="pl-12 pr-4 py-2 text-sm border-t border-[var(--ff-border-light)]">
          <Link href={allInvoicesHref(ledger, entityId)} className={`inline-flex items-center gap-1 ${INVOICE_LINK}`}>
            View all invoices for {entityName} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </td>
      </tr>
    </tfoot>
  );
}
