/**
 * The supplier-invoice line editor warns when a taxed line is coded to an
 * account on which no supply can arise.
 *
 * `approveSupplierInvoice` posts `vatType: 'standard'` on every line whenever
 * the invoice's tax amount is non-zero, against whatever GL account the line
 * names. The bank screens have warned about this since the guard shipped; no
 * invoice screen said a word, so an approver clicking through a captured
 * invoice miscoded to Salaries & Wages got no signal at all.
 *
 * Rendered, not grepped: the warning is a conditional inside the row map and
 * only a real render exercises it.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  BillLineItemsTable, type BillLineItem, type GLAccount,
} from '@/components/accounting/suppliers/BillLineItemsTable';

const ACCOUNTS: GLAccount[] = [
  { id: 'a-salaries', accountCode: '6001', accountName: 'Salaries & Wages' },
  { id: 'a-interest', accountCode: '4310', accountName: 'Interest Received' },
  { id: 'a-computer', accountCode: '5410', accountName: 'Computer Expenses' },
];

const line = (over: Partial<BillLineItem> = {}): BillLineItem => ({
  key: 'k1', description: 'x', quantity: 1, unitPrice: 100,
  taxRate: 15, glAccountId: 'a-salaries', ...over,
});

const renderTable = (lines: BillLineItem[]) => render(
  <BillLineItemsTable
    lines={lines}
    glAccounts={ACCOUNTS}
    onAdd={vi.fn()}
    onUpdate={vi.fn()}
    onRemove={vi.fn()}
  />,
);

describe('BillLineItemsTable — non-supply warning', () => {
  it('warns on a taxed line coded to salaries', () => {
    renderTable([line()]);
    expect(screen.getByText(/Employment cost — no supply, so no VAT/)).toBeTruthy();
  });

  it('names the right category for an exempt financial service', () => {
    renderTable([line({ glAccountId: 'a-interest' })]);
    expect(screen.getByText(/Exempt financial service — no supply, so no VAT/)).toBeTruthy();
  });

  it('says nothing when the line carries no tax', () => {
    // No tax on the line means no claim to warn about, whatever the account.
    renderTable([line({ taxRate: 0 })]);
    expect(screen.queryByText(/no supply, so no VAT/)).toBeNull();
  });

  it('says nothing on a real supply', () => {
    renderTable([line({ glAccountId: 'a-computer' })]);
    expect(screen.queryByText(/no supply, so no VAT/)).toBeNull();
  });

  it('says nothing when no account has been chosen yet', () => {
    renderTable([line({ glAccountId: '' })]);
    expect(screen.queryByText(/no supply, so no VAT/)).toBeNull();
  });

  it('warns per line, not per table', () => {
    renderTable([
      line({ key: 'k1', glAccountId: 'a-salaries' }),
      line({ key: 'k2', glAccountId: 'a-computer' }),
      line({ key: 'k3', glAccountId: 'a-interest' }),
    ]);
    expect(screen.getAllByText(/no supply, so no VAT/)).toHaveLength(2);
  });
});
