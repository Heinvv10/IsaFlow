import { test, expect } from '@playwright/test';

/**
 * PRD-06 Phase 4 — Receipt Auto-Match
 *
 * Exit criteria (docs/prd/PRD-06-ar-evidence-capture.md §7.2 Phase 4):
 *   monthly bank import of 500 transactions; ≥95% of customer receipts
 *   auto-match to the right invoice.
 *
 * Against prod we cannot bulk-import or mutate arbitrary data, so this
 * spec exercises the two API surfaces read-only:
 *
 *   1. GET /api/accounting/ar/receipt-match/[bankTxId] returns a scored
 *      shortlist for a real receipt (imported bank_transaction, amount > 0).
 *      Validates shape + signals + descending score ordering.
 *   2. GET /api/accounting/ar/receipt-match/[bankTxId] rejects non-receipt
 *      (negative-amount) transactions with 400.
 *   3. POST /api/accounting/ar/receipt-match/confirm rejects malformed
 *      input (missing amount, missing invoice, negative amount) with 400.
 *
 * The end-to-end "confirm flips invoice to paid" path is covered by the
 * unit tests (tests/unit/services/ar/receiptMatchService.test.ts); running
 * it against prod would require seeding a disposable invoice + bank line
 * every run, which is out of scope for this spec.
 */

test.describe('PRD-06 Phase 4 — receipt auto-match', () => {
  test('shortlist endpoint returns scored candidates for a real receipt', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const txListRes = await request.get('/api/accounting/bank-transactions?status=imported&limit=50');
    test.skip(txListRes.status() >= 400, 'bank-transactions list unavailable in this environment');
    const txListJson = await txListRes.json();
    const rows =
      (txListJson?.data?.transactions as Array<{ id: string; amount: number }> | undefined) ??
      (txListJson?.transactions as Array<{ id: string; amount: number }> | undefined) ??
      [];
    const receipt = rows.find((t) => Number(t.amount) > 0);
    test.skip(!receipt, 'No imported receipts available for shortlist test');

    const res = await request.get(`/api/accounting/ar/receipt-match/${receipt!.id}`);
    expect(res.status(), 'shortlist status').toBe(200);
    const json = await res.json();
    const data = json?.data as
      | {
          candidates: Array<{
            type: string;
            id: string;
            score: number;
            signals?: {
              paymentReferenceExact: boolean;
              paymentReferencePartial: boolean;
              portalViewBoost: number;
              scoreBreakdown: Record<string, number>;
            };
          }>;
          bankTransaction: { id: string; amount: number };
        }
      | undefined;

    expect(data, 'shortlist payload').toBeTruthy();
    expect(data!.bankTransaction.id).toBe(receipt!.id);
    expect(Array.isArray(data!.candidates)).toBe(true);
    expect(data!.candidates.length).toBeLessThanOrEqual(5);

    if (data!.candidates.length > 0) {
      // All candidates are customer_invoice; scores are non-negative and descending.
      for (let i = 0; i < data!.candidates.length; i++) {
        const c = data!.candidates[i]!;
        expect(c.type).toBe('customer_invoice');
        expect(c.score).toBeGreaterThanOrEqual(0);
        if (i > 0) {
          expect(c.score).toBeLessThanOrEqual(data!.candidates[i - 1]!.score);
        }
        if (c.signals) {
          expect(c.signals.scoreBreakdown).toHaveProperty('reference');
          expect(c.signals.scoreBreakdown).toHaveProperty('amount');
          expect(c.signals.scoreBreakdown).toHaveProperty('date');
        }
      }
    }
  });

  test('shortlist rejects a non-receipt (negative amount) with 400', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const txListRes = await request.get('/api/accounting/bank-transactions?limit=50');
    test.skip(txListRes.status() >= 400, 'bank-transactions list unavailable');
    const rows =
      ((await txListRes.json())?.data?.transactions as Array<{ id: string; amount: number }> | undefined) ??
      [];
    const payment = rows.find((t) => Number(t.amount) < 0);
    test.skip(!payment, 'No negative-amount transactions to exercise the guard');

    const res = await request.get(`/api/accounting/ar/receipt-match/${payment!.id}`);
    expect(res.status(), 'non-receipt guard status').toBe(400);
  });

  test('confirm endpoint validates body', async ({ request, baseURL }) => {
    test.skip(!baseURL, 'baseURL required');

    const missingAll = await request.post('/api/accounting/ar/receipt-match/confirm', {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(missingAll.status(), 'empty body').toBe(400);

    const missingAmount = await request.post('/api/accounting/ar/receipt-match/confirm', {
      data: {
        bankTxId: '00000000-0000-0000-0000-000000000000',
        customerInvoiceId: '00000000-0000-0000-0000-000000000001',
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(missingAmount.status(), 'missing amount').toBe(400);

    const negAmount = await request.post('/api/accounting/ar/receipt-match/confirm', {
      data: {
        bankTxId: '00000000-0000-0000-0000-000000000000',
        customerInvoiceId: '00000000-0000-0000-0000-000000000001',
        amount: -10,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(negAmount.status(), 'negative amount').toBe(400);
  });
});
