/**
 * The migration wizard's import banner.
 *
 * Both invoice pages rendered `Imported {result.succeeded} … Failed:
 * {result.failed}` — fields the service has never returned — so every import
 * showed "Imported undefined invoices". R-002's whole point is that a row with
 * rounding drift imports WITH A WARNING, and that warning reached the browser
 * in the API envelope and was then dropped on the floor.
 *
 * Rendered, not grepped: the counts and both issue lists are conditionals
 * inside the component and only a real render exercises them.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import InvoiceImportResult from '@/components/accounting/migration/InvoiceImportResult';

describe('InvoiceImportResult', () => {
  it('shows the counts the service actually returns', () => {
    render(<InvoiceImportResult result={{ imported: 3, skipped: 1 }} />);
    expect(screen.getByText(/Imported 3 invoices\. Skipped: 1\./)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('shows an R-002 rounding warning next to the count', () => {
    render(<InvoiceImportResult result={{
      imported: 1,
      skipped: 0,
      warnings: [{ message: 'Imported with a rounding difference: INV-1 — subtotal 1000.00 + tax 150.00 != total 1150.01', severity: 'warning' }],
    }} />);
    expect(screen.getByText(/rounding difference: INV-1/)).toBeTruthy();
  });

  it('shows the per-row errors as well', () => {
    render(<InvoiceImportResult result={{
      imported: 0,
      skipped: 1,
      errors: [{ message: 'Customer not found: Acme' }],
    }} />);
    expect(screen.getByText(/Customer not found: Acme/)).toBeTruthy();
  });

  it('renders nothing extra when there are no issues', () => {
    const { container } = render(<InvoiceImportResult result={{ imported: 2, skipped: 0, errors: [], warnings: [] }} />);
    expect(container.firstElementChild!.children.length).toBe(1);
  });
});
