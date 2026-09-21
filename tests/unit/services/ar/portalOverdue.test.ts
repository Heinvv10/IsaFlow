/**
 * R-095 round 4 — the portal's overdue figure is the part of the statement's
 * closing balance that sits on past-due invoices once every credit has settled
 * the oldest-due debt first. It can never exceed the balance.
 */
import { describe, expect, it } from 'vitest';
import { overdueOfClosing } from '@/modules/accounting/services/ar/portalOverdue';

describe('overdueOfClosing', () => {
  it('is the balance less what is not yet due', () => {
    expect(overdueOfClosing(180, 30)).toBe(150);
  });
  it('never exceeds the closing balance', () => {
    expect(overdueOfClosing(629.51, 0)).toBe(629.51);
  });
  it('is zero when everything owed is not yet due', () => {
    expect(overdueOfClosing(500, 1234.56)).toBe(0);
  });
  it('is zero for a customer in credit', () => {
    expect(overdueOfClosing(-50, 0)).toBe(0);
  });
  it('rounds to the cent', () => {
    expect(overdueOfClosing(1434.56, 1234.56)).toBe(200);
  });
});
