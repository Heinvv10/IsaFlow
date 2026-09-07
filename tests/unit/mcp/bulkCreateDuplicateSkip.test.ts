/**
 * A repeated invoice_number SKIPS that element — it does not refuse the call.
 *
 * `bulk_create_supplier_invoices` refused the WHOLE batch when two elements
 * carried the same (supplier_id, invoice_number): a supplier does not issue one
 * number twice, so the second is a duplicated element rather than a second
 * bill. The guard is right; refusing 100 good invoices over it is not. The Sage
 * export for the Velocity Fibre rebuild carried 14 such pairs, so batches
 * failed until every one had been found and renumbered by hand — the exact
 * bisect-it-yourself work the bulk tool exists to remove.
 *
 * `bulk_allocate_bank_transactions` already answers this correctly: a fact
 * about the DATA is a skip with a reason, and the rest of the batch posts. This
 * brings the create tool onto the same rule.
 *
 * WHY THIS IS SAFE WHERE A MID-WRITE SKIP WOULD NOT BE: the check runs in the
 * parse pass, before the first INSERT. Nothing has been written when an element
 * is set aside, so the tool still returns normally and the registry's savepoint
 * is never asked to discard a partial batch. All-or-nothing is unchanged for
 * genuine faults — those still THROW from inside the create loop.
 *
 * NOT a books-level duplicate check. `supplier_invoices` carries NO unique
 * index on invoice_number (verified against the schema: only the primary key),
 * and `idx_supplier_invoices_duplicate_fp` is deliberately non-unique. The
 * database accepts the same number twice, so a "this bill is already in the
 * books" rule would be one this tool invented on its own. In-batch repeats are
 * the only duplicates that are unambiguously duplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createSupplierInvoice, supplierBelongsToCompany, accountsBelongToCompany } = vi.hoisted(() => ({
  createSupplierInvoice: vi.fn(),
  supplierBelongsToCompany: vi.fn(),
  accountsBelongToCompany: vi.fn(),
}));

vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({ createSupplierInvoice }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany, customerBelongsToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class extends Error {},
}));

import { bulkCreateSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkInvoices';

const SUPPLIER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPPLIER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: '99999999-9999-4999-8999-999999999999',
  tokenJti: 'jti-1',
} as never;

function invoice(supplierId: string, invoiceNumber: string) {
  return {
    supplier_id: supplierId,
    invoice_number: invoiceNumber,
    invoice_date: '2026-03-01',
    lines: [{ description: 'Fibre', quantity: 1, unit_price: 100 }],
  };
}

/** The tool's payload as the wire delivers it. */
function call(invoices: Record<string, unknown>[]) {
  return bulkCreateSupplierInvoicesTool.handler(
    { invoices, idempotency_key: 'k1' }, ctx,
  );
}

/** A refusal carries plain text, not JSON — `toolError`, not `ok`. */
function errText(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text;
}

/** `ok()` wraps the payload; read it back the way a caller would. */
function body(result: unknown): Record<string, unknown> {
  const text = (result as { content: { text: string }[] }).content[0]!.text;
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  supplierBelongsToCompany.mockResolvedValue(true);
  accountsBelongToCompany.mockResolvedValue(true);
  let n = 0;
  createSupplierInvoice.mockImplementation(async (_c: string, input: { invoiceNumber: string }) => ({
    id: `inv-${++n}`, invoiceNumber: input.invoiceNumber, supplierId: SUPPLIER_A,
    invoiceDate: '2026-03-01', totalAmount: 100, status: 'draft',
  }));
});

describe('bulk_create_supplier_invoices — a repeat is skipped, not fatal', () => {
  it('creates the rest of the batch and reports the repeat', async () => {
    const result = await call([
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-2'),
    ]);
    const out = body(result);

    expect(out.created_count).toBe(2);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(2);
    const skipped = out.skipped as { index: number; reason: string }[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.index).toBe(1);
    expect(skipped[0]!.reason).toMatch(/INV-1/);
    expect(skipped[0]!.reason).toMatch(/invoices\[0\]/);
  });

  // THE HEADLINE CLAIM, and it had no coverage until an adversarial review
  // pointed that out: `created[].index` is the CALLER's index, not the position
  // in the filtered list. It only diverges when a skip lands BEFORE a create,
  // so a batch shaped [dup, dup, unique] is the only shape that pins it —
  // reverting to a running counter over the kept list would report index 1 for
  // the third element and an agent would attribute the bill to the wrong
  // payload entry.
  it('reports the CALLER index on created invoices, not the kept-list position', async () => {
    const out = body(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-2'),
    ]));
    expect((out.invoices as { index: number }[]).map((i) => i.index)).toEqual([0, 2]);
    expect((out.skipped as { index: number }[]).map((i) => i.index)).toEqual([1]);
  });

  // Same divergence on the THROW path: elementError names the caller's index.
  it('names the CALLER index when an element fails after a skip', async () => {
    createSupplierInvoice
      .mockResolvedValueOnce({
        id: 'inv-1', invoiceNumber: 'INV-1', supplierId: SUPPLIER_A,
        invoiceDate: '2026-03-01', totalAmount: 100, status: 'draft',
      })
      .mockRejectedValueOnce(new Error('boom'));
    await expect(call([
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-1'),
      invoice(SUPPLIER_A, 'INV-2'),
    ])).rejects.toThrow(/invoices\[2\]/);
  });

  it('keeps the FIRST occurrence, not the last', async () => {
    await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_A, 'INV-1')]);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(1);
    const [, input] = createSupplierInvoice.mock.calls[0]!;
    expect(input.invoiceNumber).toBe('INV-1');
  });

  // The key is the PAIR. Two suppliers may each issue their own INV-1, and
  // treating that as a duplicate would silently drop a real bill — the failure
  // mode that matters more than the one being fixed.
  it('does not treat the same number from different suppliers as a repeat', async () => {
    const result = await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_B, 'INV-1')]);
    const out = body(result);
    expect(out.created_count).toBe(2);
    expect(out.skipped).toHaveLength(0);
  });

  // `bulkAllocationSkip` needs a `nothingToPostText` refusal because every line
  // in a batch can legitimately be skipped, leaving a batch id that reverses
  // nothing. This tool cannot reach that state: the FIRST occurrence of every
  // key is always kept, so a batch that parses always creates at least one
  // invoice however many repeats it carries. Asserted rather than assumed —
  // if the partition ever started skipping a first occurrence, an empty
  // success would be the symptom and nothing else here would catch it.
  it('always creates at least one — a batch of pure repeats cannot arise', async () => {
    for (const n of [2, 5, 20]) {
      vi.clearAllMocks();
      supplierBelongsToCompany.mockResolvedValue(true);
      accountsBelongToCompany.mockResolvedValue(true);
      createSupplierInvoice.mockResolvedValue({
        id: 'inv-1', invoiceNumber: 'INV-1', supplierId: SUPPLIER_A,
        invoiceDate: '2026-03-01', totalAmount: 100, status: 'draft',
      });
      const out = body(await call(Array.from({ length: n }, () => invoice(SUPPLIER_A, 'INV-1'))));
      expect(out.created_count).toBe(1);
      expect(out.skipped).toHaveLength(n - 1);
      // Every element of the caller's payload is accounted for exactly once.
      const indices = [
        ...(out.invoices as { index: number }[]).map((i) => i.index),
        ...(out.skipped as { index: number }[]).map((i) => i.index),
      ].sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  // The skip is a PARSE-pass decision, so nothing has been written when an
  // element is set aside. A genuine fault still throws from the create loop and
  // still unwinds the batch through the registry's savepoint.
  it('still throws — never returns — when an element genuinely fails', async () => {
    createSupplierInvoice.mockRejectedValueOnce(new Error('boom'));
    await expect(call([invoice(SUPPLIER_A, 'INV-1')])).rejects.toThrow(/invoices\[0\]/);
  });
});

describe('bulk_create_supplier_invoices — same number, different bill is REFUSED', () => {
  /**
   * The hole an adversarial review found in the first version of this guard.
   *
   * Keying on (supplier_id, invoice_number) alone made
   * `[{A, "INV-1001", R1,000}, {A, "INV-1001", R48,500}]` create the R1,000
   * bill and silently discard the R48,500 one under an HTTP 200, with nothing
   * to find it by. Those are two different bills under one number — a numbering
   * error in the source — not a duplicated element.
   *
   * The books already define it this way: migration 412 fingerprints a supplier
   * invoice on (vat_number, invoice_number, total_amount). A guard weaker than
   * the one the ledger uses is not a guard.
   */
  it('refuses two bills under one number rather than dropping the larger', async () => {
    const small = invoice(SUPPLIER_A, 'INV-1001');
    const large = {
      ...invoice(SUPPLIER_A, 'INV-1001'),
      lines: [{ description: 'Fibre', quantity: 1, unit_price: 48500 }],
    };
    expect(errText(await call([small, large]))).toMatch(/not the same bill/i);
    // Nothing created: a refusal, not a partial run.
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  // The refusal NAMES what differs. It used to assert the pair differed "in
  // their amounts, dates or lines" whatever the actual difference was — so a
  // batch differing only in `notes` was refused with a message listing three
  // fields that were identical. An agent cannot act on that.
  it.each([
    ['a different date', { invoice_date: '2026-04-01' }, /invoiceDate/],
    ['a different quantity', { lines: [{ description: 'Fibre', quantity: 2, unit_price: 100 }] }, /items/],
    ['a different description', { lines: [{ description: 'Other', quantity: 1, unit_price: 100 }] }, /items/],
    ['a different note only', { notes: 'second copy' }, /notes/],
    ['a different reference only', { reference: 'PO-99' }, /reference/],
  ])('refuses on %s and names the field', async (_label, override, named) => {
    const text = errText(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      { ...invoice(SUPPLIER_A, 'INV-1'), ...override },
    ]));
    expect(text).toMatch(/not the same bill/i);
    expect(text).toMatch(named);
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  // `accountIds` is derived from `items`, so reporting it beside `items` would
  // name the same difference twice.
  it('does not report the derived accountIds as a difference of its own', async () => {
    const text = errText(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      {
        ...invoice(SUPPLIER_A, 'INV-1'),
        lines: [{ description: 'Fibre', quantity: 1, unit_price: 100, gl_account_id: ACCOUNT }],
      },
    ]));
    expect(text).toMatch(/items/);
    expect(text).not.toMatch(/accountIds/);
  });

  // A FALSE refusal is the mirror of the HIGH: it blocks a batch that is
  // legitimately a duplicate, which is the friction this tool exists to remove.
  // `tax_rate` omitted and `tax_rate: 15` produce the SAME bill — the service
  // applies `?? DEFAULT_SUPPLIER_TAX_RATE` — so the comparison resolves that one
  // constant default before comparing. The constant is imported from the module
  // both readers share, never restated here or in the guard.
  it('treats an omitted tax_rate as the default, not as a difference', async () => {
    const out = body(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      { ...invoice(SUPPLIER_A, 'INV-1'), tax_rate: 15 },
    ]));
    expect(out.created_count).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the tax rate genuinely differs', async () => {
    const text = errText(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      { ...invoice(SUPPLIER_A, 'INV-1'), tax_rate: 0 },
    ]));
    expect(text).toMatch(/not the same bill/i);
    expect(text).toMatch(/taxRate/);
  });

  // A COMPUTED default is deliberately not resolved: dueDate comes from
  // calculateDueDate(invoiceDate, paymentTerms), and reimplementing that to
  // compare two elements would be a second copy of a business rule. An omitted
  // vs explicitly-equal due date stays a refusal — the safe direction, and the
  // message names the field.
  it('does not try to resolve the computed dueDate default', async () => {
    const text = errText(await call([
      invoice(SUPPLIER_A, 'INV-1'),
      { ...invoice(SUPPLIER_A, 'INV-1'), due_date: '2026-03-31' },
    ]));
    expect(text).toMatch(/dueDate/);
  });

  it('still skips a byte-identical re-send, which is the case it exists for', async () => {
    const out = body(await call([invoice(SUPPLIER_A, 'INV-1'), invoice(SUPPLIER_A, 'INV-1')]));
    expect(out.created_count).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect((out.skipped as { reason: string }[])[0]!.reason).toMatch(/identical/i);
  });
});
