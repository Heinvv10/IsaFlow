/**
 * A bill line copied from an imported purchase order carries the PO's effective unit price, which can have up to six
 * decimals (po_items.unit_price, migration 1001: a discounted or 4-decimal Sage line). The price input must accept it:
 * with step 0.01 the browser blocks the bill form ("Please enter a valid value") and the user retypes a rounded price.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { BillLineItemsTable, type BillLineItem } from '@/components/accounting/suppliers/BillLineItemsTable';

const line: BillLineItem = { key: 'k1', description: 'Cable ties', quantity: 10000, unitPrice: 0.1234, taxRate: 15, glAccountId: '' };

describe('the bill line unit price', () => {
  it('accepts a six-decimal price from a PO line without blocking the form', () => {
    render(
      <form>
        <BillLineItemsTable lines={[{ ...line }, { ...line, key: 'k2', unitPrice: 33.333333 }]} glAccounts={[]} onAdd={vi.fn()} onUpdate={vi.fn()} onRemove={vi.fn()} />
      </form>,
    );
    for (const n of [1, 2]) {
      const input = screen.getByLabelText(`Line ${n} unit price`) as HTMLInputElement;
      expect(input.validity.stepMismatch).toBe(false);
      expect(input.checkValidity()).toBe(true);
    }
  });
});
