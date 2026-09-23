// "View all invoices" from the aging panels lands on the list pages with the
// list's own filter params, which each list page hydrates from.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { allInvoicesHref, ViewAllInvoicesFooter } from '@/components/accounting/ViewAllInvoicesLink';
import { hydrateARFilters } from '@/components/accounting/customer-invoices/listQuery';

const ID = '3f8a1c2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';

describe('allInvoicesHref', () => {
  it('customer link is exactly what the customer list hydrates as a customer filter', () => {
    const href = allInvoicesHref('customer', ID, 'Herotel & Sons');
    expect(href).toBe(`/accounting/customer-invoices?customer=${ID}`);
    const query = Object.fromEntries(new URL(href, 'http://x').searchParams);
    expect(hydrateARFilters(query).customerId).toBe(ID);
  });

  it('supplier link carries the id and an encoded label', () => {
    expect(allInvoicesHref('supplier', ID, 'A&B Supplies'))
      .toBe(`/accounting/supplier-invoices?supplier_id=${ID}&supplier_label=A%26B+Supplies`);
  });
});

describe('ViewAllInvoicesFooter', () => {
  it('renders the link for the entity', () => {
    render(<table><ViewAllInvoicesFooter ledger="customer" entityId={ID} entityName="Herotel" colSpan={6} /></table>);
    expect(screen.getByText(/View all invoices for Herotel/).closest('a')?.getAttribute('href'))
      .toBe(`/accounting/customer-invoices?customer=${ID}`);
  });
});
