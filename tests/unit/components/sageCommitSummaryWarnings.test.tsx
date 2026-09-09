/**
 * The Sage import must SHOW its warnings, not merely return them.
 *
 * `settledAtSource` refuses a non-finite or negative source paid amount and
 * clamps an overpayment; `CommitSummary.warnings` is the only record that the
 * discarded credit ever existed — the row itself keeps no trace and re-running
 * the import is a no-op on an already-committed invoice. Before this component
 * existed the page mapped a fixed key list and dropped `warnings` on the floor,
 * so the operator saw "5 created" and nothing else.
 *
 * Rendered, not grepped: the disclosure is a conditional and only a real render
 * exercises it.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { SageCommitSummary, type SageCommitSummaryData } from '@/components/admin/SageCommitSummary';

const section = (over: Partial<{ created: number; skipped: number; failed: string[] }> = {}) =>
  ({ created: 0, skipped: 0, failed: [], ...over });

const summary = (over: Partial<SageCommitSummaryData> = {}): SageCommitSummaryData => ({
  accounts: section(), customers: section(), suppliers: section(),
  arInvoices: section({ created: 5 }), apInvoices: section(),
  ...over,
});

describe('SageCommitSummary', () => {
  it('shows every warning the commit returned', () => {
    render(<SageCommitSummary summary={summary({
      warnings: [
        'INV-1: the source\'s settled amount exceeds the invoice total of 1150 by 200 — that much credit was NOT imported',
        'INV-2: source paid amount is not a finite number (NaN) — imported as unpaid',
      ],
    })} />);

    expect(screen.getByText(/2 warnings/)).toBeTruthy();
    expect(screen.getByText(/200 — that much credit was NOT imported/)).toBeTruthy();
    expect(screen.getByText(/not a finite number/)).toBeTruthy();
  });

  it('singularises one warning and still renders it', () => {
    render(<SageCommitSummary summary={summary({ warnings: ['INV-9: imported as unpaid'] })} />);
    expect(screen.getByText(/1 warning —/)).toBeTruthy();
    expect(screen.queryByText(/1 warnings/)).toBeNull();
  });

  it('shows no warning disclosure on a clean commit', () => {
    render(<SageCommitSummary summary={summary()} />);
    expect(screen.queryByText(/warning/i)).toBeNull();
    expect(screen.getByText('5 created')).toBeTruthy();
  });

  it('tolerates a summary from a server that predates the warnings field', () => {
    const legacy = summary();
    delete (legacy as { warnings?: string[] }).warnings;
    render(<SageCommitSummary summary={legacy} />);
    expect(screen.queryByText(/warning/i)).toBeNull();
  });

  it('keeps failures in their own disclosure, separate from warnings', () => {
    render(<SageCommitSummary summary={summary({
      apInvoices: section({ failed: ['INV-7: Supplier not found'] }),
      warnings: ['INV-8: imported as unpaid'],
    })} />);
    expect(screen.getByText('Show failures')).toBeTruthy();
    expect(screen.getByText(/\[apInvoices\] INV-7: Supplier not found/)).toBeTruthy();
    expect(screen.getByText(/1 warning —/)).toBeTruthy();
  });
});
