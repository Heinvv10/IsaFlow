/**
 * WP1 PR-A review round 5: a statement balance that nothing checked must not look like a printed one. When the
 * batch's balanceSource is 'pdf_read' (a text-parsed PDF's running balance) or 'ai_read' (a PDF read by the AI
 * model), StatementBalanceWidget shows a caveat under the balance and qualifies the Difference as not checked —
 * a dropped row that is also missing from the ledger otherwise reads as a zero Difference, "reconciled".
 * A running_balance (or printed) figure shows neither. `fetch` is stubbed with the real envelope of
 * GET /api/accounting/bank-import-batches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { StatementBalanceWidget } from '@/components/accounting/StatementBalanceWidget';

const PDF_READ = "From the PDF's running balance (not checked against a printed closing)";
const AI_READ = 'Read from the PDF by AI (not checked against the file)';
// lucide's CheckCircle2, the widget's "reconciled" icon, under its class names across versions.
const CHECK_ICON = 'svg.lucide-circle-check-big, svg.lucide-check-circle-2, svg.lucide-circle-check';

const batch = (balanceSource: string | null) => ({
  id: 'b1', bankAccountId: 'acct-1', statementDate: '2026-09-30', bankFormat: 'absa', openingBalance: 1000,
  closingBalance: 1150, balanceSource, importChannel: 'upload', sourceLabel: 'ABSA', transactionCount: 3,
  transactionsRemaining: 3, transactionsAllocated: 0, sourceFilename: 'sept.pdf', importedBy: 'u1', bulkImportId: null,
  createdAt: '2026-10-01T08:00:00.000Z',
});

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function show(balanceSource: string | null) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, data: { batches: [batch(balanceSource)] } }), { status: 200 }));
  render(<StatementBalanceWidget bankAccountId="acct-1" glBalance={1150} />);
  await screen.findByText('Closing Balance');
}

describe('StatementBalanceWidget: an unchecked statement balance says so', () => {
  it('pdf_read: the caveat under the balance, and the Difference marked not checked', async () => {
    await show('pdf_read');
    expect(screen.getByText(PDF_READ)).toBeTruthy();
    expect(screen.queryByText(AI_READ)).toBeNull();
    expect(screen.getByText(/Difference \(not checked\)/)).toBeTruthy();
  });

  it('pdf_read at a zero Difference (glBalance = the closing) is never shown as reconciled: no teal, no check icon', async () => {
    await show('pdf_read'); // closing 1150, glBalance 1150
    expect(document.querySelector('[class*="teal"]')).toBeNull();
    expect(document.querySelector(CHECK_ICON)).toBeNull();
    // The guard is what removes them: the same zero Difference from a running_balance IS shown reconciled.
    cleanup();
    await show('running_balance');
    expect(document.querySelector('[class*="teal"]')).not.toBeNull();
    expect(document.querySelector(CHECK_ICON)).not.toBeNull();
  });

  it('ai_read: its own caveat, and the Difference marked not checked', async () => {
    await show('ai_read');
    expect(screen.getByText(AI_READ)).toBeTruthy();
    expect(screen.queryByText(PDF_READ)).toBeNull();
    expect(screen.getByText(/Difference \(not checked\)/)).toBeTruthy();
  });

  it('running_balance (and printed): no caveat, a plain Difference', async () => {
    for (const source of ['running_balance', 'printed']) {
      await show(source);
      expect(screen.queryByText(PDF_READ)).toBeNull();
      expect(screen.queryByText(AI_READ)).toBeNull();
      expect(screen.queryByText(/not checked/)).toBeNull();
      expect(screen.getByText('Difference')).toBeTruthy();
      cleanup();
    }
  });
});
