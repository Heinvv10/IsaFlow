/**
 * approveCreditNote's application of the note (auto-apply capping, the FIFO walk)
 * and applyCreditNoteToInvoice's refusals — split out of creditNoteService.test.ts
 * for the 300-line limit; same harness, assertions unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockSql, COMPANY_ID, CN_ID, USER_ID, creditNoteRow } from './creditNoteService.harness';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { approveCreditNote, applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteService';

/**
 * The auto-apply used to add the note's full total with no cap and set
 * autoApplied = true without inspecting the row count.
 */
describe('approveCreditNote — auto-apply is capped and verified', () => {
  const INV = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

  function linkedNote() {
    return creditNoteRow({ customer_invoice_id: INV, total_amount: 1150 });
  }

  /** Answers the guard, the locked invoice read, and the two UPDATEs. */
  function wire(invoice: { total_amount: string; amount_paid: string } | null) {
    const applied: number[] = [];
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(linkedNote() as never);
    mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) {
        return Promise.resolve([{ allocated: 0 }]);
      }
      // The lock read is where the outstanding balance now comes from, so the
      // cap these tests describe is computed from its figures.
      if (/FOR UPDATE/i.test(text)) {
        if (!invoice) return Promise.resolve([]);
        const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid);
        return Promise.resolve([{ id: INV, status: 'approved', outstanding }]);
      }
      if (/SELECT ci\.id/i.test(text)) {
        return Promise.resolve([]);
      }
      if (/UPDATE customer_invoices SET amount_paid = COALESCE\(amount_paid, 0\) \+/i.test(text)) {
        applied.push(Number(values[0]));
        return Promise.resolve([{ id: INV }]);
      }
      if (/UPDATE credit_notes SET status/i.test(text)) {
        return Promise.resolve([linkedNote()]);
      }
      return Promise.resolve([]);
    }) as never);
    return applied;
  }

  it('caps the applied amount at the invoice outstanding balance', async () => {
    // Invoice owes 150; the note is worth 1150. Only 150 may be consumed.
    const applied = wire({ total_amount: '1150.00', amount_paid: '1000.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([150]);
  });

  it('applies the full total when the invoice owes more than the note', async () => {
    const applied = wire({ total_amount: '5000.00', amount_paid: '0.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([1150]);
  });

  it('applies nothing to an already-settled invoice, leaving the credit unallocated', async () => {
    const applied = wire({ total_amount: '1150.00', amount_paid: '1150.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([]);
  });

  it('refuses when the linked invoice no longer exists rather than reporting a phantom apply', async () => {
    wire(null);
    await expect(approveCreditNote(COMPANY_ID, CN_ID, USER_ID))
      .rejects.toThrow(/no longer exists in this company/);
  });
});

/**
 * FIFO APPLICATION (L2, migration 677).
 *
 * Approving a note no longer stops at the document it names. The remainder
 * walks the same customer's open invoices oldest first, and every application
 * writes a `credit_note_allocations` row — the invariant these tests pin is
 * that the rows and the money always move together, because `applied_amount`
 * is now the sum of the rows rather than a figure written beside them.
 */
describe('approveCreditNote — FIFO application across open documents', () => {
  const INV_OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
  const INV_NEW = 'aaaaaaaa-0000-4000-8000-000000000002';

  interface Wired {
    /** [invoiceId, amount] per allocation row inserted. */
    rows: [string, number][];
    /** [invoiceId, amount] per amount_paid increment. */
    money: [string, number][];
    /** The status the note was finally written with. */
    status: () => string | undefined;
    appliedAmount: () => number | undefined;
  }

  function wireOpen(open: { id: string; outstanding: number }[]): Wired {
    const rows: [string, number][] = [];
    const money: [string, number][] = [];
    let status: string | undefined;
    let appliedAmount: number | undefined;
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(
      creditNoteRow({ total_amount: 1150 }) as never,
    );
    mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) {
        return Promise.resolve([{ allocated: 0 }]);
      }
      // The locked re-read: the plan consumes THESE figures, not the candidate
      // query's. Both are served from the same fixture here.
      if (/FOR UPDATE/i.test(text)) {
        const wanted = new Set((values[0] as string[]) ?? []);
        return Promise.resolve(open
          .filter((o) => wanted.has(o.id))
          .map((o) => ({ id: o.id, status: 'approved', outstanding: o.outstanding })));
      }
      if (/SELECT ci\.id/i.test(text)) {
        return Promise.resolve(open.map((o) => ({ id: o.id, outstanding: o.outstanding })));
      }
      if (/INSERT INTO credit_note_allocations/i.test(text)) {
        rows.push([String(values[2]), Number(values[3])]);
        return Promise.resolve([]);
      }
      if (/UPDATE customer_invoices SET amount_paid = COALESCE\(amount_paid, 0\) \+/i.test(text)) {
        money.push([String(values[1]), Number(values[0])]);
        return Promise.resolve([{ id: values[1] }]);
      }
      if (/UPDATE credit_notes SET status/i.test(text)) {
        status = String(values[0]);
        appliedAmount = Number(values[3]);
        return Promise.resolve([creditNoteRow({ status })]);
      }
      return Promise.resolve([]);
    }) as never);
    return { rows, money, status: () => status, appliedAmount: () => appliedAmount };
  }

  it('settles the oldest invoice in full and part-settles the next', async () => {
    const w = wireOpen([
      { id: INV_OLD, outstanding: 400 },
      { id: INV_NEW, outstanding: 5000 },
    ]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.money).toEqual([[INV_OLD, 400], [INV_NEW, 750]]);
    expect(w.status()).toBe('applied');
    expect(w.appliedAmount()).toBe(1150);
  });

  it('writes one allocation row per application, for exactly the money moved', async () => {
    const w = wireOpen([
      { id: INV_OLD, outstanding: 400 },
      { id: INV_NEW, outstanding: 5000 },
    ]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.rows).toEqual(w.money);
    // …and the column is the sum of the rows, never an independent figure.
    expect(w.appliedAmount()).toBe(w.rows.reduce((s, [, a]) => s + a, 0));
  });

  it('leaves the excess on account as partially_applied when nothing more is open', async () => {
    const w = wireOpen([{ id: INV_OLD, outstanding: 400 }]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.money).toEqual([[INV_OLD, 400]]);
    expect(w.status()).toBe('partially_applied');
    expect(w.appliedAmount()).toBe(400);
  });

  it('applies nothing and stays approved when auto_apply is "none"', async () => {
    const w = wireOpen([{ id: INV_OLD, outstanding: 5000 }]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply: 'none' });
    expect(w.money).toEqual([]);
    expect(w.rows).toEqual([]);
    expect(w.status()).toBe('approved');
    expect(w.appliedAmount()).toBe(0);
  });
});

/**
 * The two refusals the MANUAL apply gained.
 *
 * Both are about not extending something that cannot be undone correctly. The
 * status guard stops a credit landing on a document that has posted nothing;
 * the allocation guard stops a note whose column and rows already disagree from
 * being given another row, which would strand the original credit on an invoice
 * nothing names.
 */
describe('applyCreditNoteToInvoice — what it refuses before it writes', () => {
  const INVOICE = 'cccccccc-0000-4000-8000-cccccccccccc';
  const CLIENT = 'client-uuid';

  function wireApply(invoice: Record<string, unknown>, allocated: number) {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(
      creditNoteRow({ status: 'approved', applied_amount: 300 }) as never,
    );
    mockSql.mockImplementation(((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) return Promise.resolve([{ allocated }]);
      if (/SELECT \* FROM customer_invoices/i.test(text)) return Promise.resolve([invoice]);
      return Promise.resolve([creditNoteRow({ status: 'applied' })]);
    }) as never);
  }

  const openInvoice = (status: string) => ({
    id: INVOICE, client_id: CLIENT, customer_id: CLIENT,
    total_amount: '1000.00', amount_paid: '0.00', status,
  });

  it('refuses an invoice that has posted nothing', async () => {
    wireApply(openInvoice('draft'), 300);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/status: draft/);
  });

  it('refuses a cancelled invoice for the same reason', async () => {
    wireApply(openInvoice('cancelled'), 300);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/status: cancelled/);
  });

  it('refuses a note whose applied_amount the allocation rows do not account for', async () => {
    // applied_amount 300, rows totalling 120 — the other 180 went somewhere no
    // row names, and a cancel would never give it back.
    wireApply(openInvoice('sent'), 120);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/Reconcile the note by hand/);
  });

  it('applies when the status is live and the rows account for the column', async () => {
    wireApply(openInvoice('sent'), 300);
    const out = await applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID);
    expect(out.status).toBe('applied');
  });
});
