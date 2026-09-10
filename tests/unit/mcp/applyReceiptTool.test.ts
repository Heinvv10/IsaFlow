/**
 * `apply_receipt_to_invoice`, `suggest_receipt_matches`, `list_unapplied_receipts`.
 *
 * What is worth pinning:
 *
 *  - **Exactly one source.** Naming both `payment_id` and `bank_transaction_id`
 *    or neither is refused before any lookup. The two branches have different
 *    ledger effects — one posts a journal and the other does not — so an
 *    ambiguous call is a request fault, not something to resolve by precedence.
 *  - **The dry run runs every guard the live path runs.** It is the same
 *    `planReceiptApplication` / `validateBankReceiptApplication` call; only the
 *    write is skipped. A dry run that passed where the live call refuses is the
 *    failure `docs/mcp/CONTRACTS.md` §6 calls worse than no dry run.
 *  - **The dry run sets `wroteNothing`.** Without it the preview is stored under
 *    the idempotency key and the real call that follows — same intent, same key —
 *    is served the preview forever.
 *  - **Only PRE-write validation returns `toolError`.** Once `applyReceiptPlan`
 *    or `confirmReceiptMatch` has been called, a failure must THROW: the
 *    savepoint rolls back on a throw and not on a returned error, and a refusal
 *    frees the key for a retry that applies the receipt twice.
 *  - **The bank branch stamps `mcp:apply_receipt_to_invoice:v1`.** Without it
 *    `createJournalEntry` falls back to `defaultHumanMeta(userId)` and the
 *    posting claims a person made it by hand.
 *  - `suggest_receipt_matches` proposes and never posts, and reports how many
 *    invoices were considered so five-of-five and five-of-fifty differ.
 *  - `list_unapplied_receipts` reports orphaned receipts in `excludedRows` with
 *    their amount rather than dropping them, and its envelope accounts for
 *    every row in its universe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({
  planReceiptApplication: vi.fn(),
  applyReceiptPlan: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchConfirmService', () => ({
  validateBankReceiptApplication: vi.fn(),
  confirmReceiptMatch: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  assertBankAllocationAuthority: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/receiptMatchService', () => ({
  getReceiptMatchCandidates: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptService', () => ({
  getUnappliedReceipts: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptOrigin', () => ({
  getUnappliedReceiptOrigins: vi.fn(),
}));

import {
  planReceiptApplication,
  applyReceiptPlan,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import {
  validateBankReceiptApplication,
  confirmReceiptMatch,
} from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { getUnappliedReceipts } from '@/modules/accounting/services/ar/unappliedReceiptService';
import { getUnappliedReceiptOrigins } from '@/modules/accounting/services/ar/unappliedReceiptOrigin';
import { applyReceiptToInvoiceTool } from '@/lib/mcp/tools/writeApplyReceipt';
import {
  listUnappliedReceiptsTool,
  suggestReceiptMatchesTool,
} from '@/lib/mcp/tools/receipts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INV_A = '44444444-4444-4444-8444-444444444444';
const TX = '66666666-6666-4666-8666-666666666666';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post', 'read:invoices', 'read:bank-tx'],
    tokenJti: 'jti',
    oauthAppId: null,
  };
}
function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const LINE = {
  invoiceId: INV_A,
  invoiceNumber: 'INV0001',
  amount: 600,
  outstandingBefore: 600,
  outstandingAfter: 0,
  statusBefore: 'approved',
  statusAfter: 'paid',
};

function plan() {
  return {
    paymentId: PAYMENT,
    paymentNumber: 'RCP0001',
    customerId: CUSTOMER,
    paymentTotal: 1000,
    allocatedBefore: 0,
    allocatedAfter: 600,
    unappliedBefore: 1000,
    unappliedAfter: 400,
    paymentStatusBefore: 'confirmed',
    paymentStatusAfter: 'confirmed',
    lines: [LINE],
    postsJournal: false as const,
  };
}

const ALLOC = { allocations: [{ invoice_id: INV_A, amount: 600 }] };

const ORIGINS = {
  agent: { receipts: 34, unapplied: 2436024 },
  system: { receipts: 2, unapplied: 245000 },
  notStampedAsAgent: { receipts: 1, unapplied: 10000 },
  noJournal: { receipts: 0, unapplied: 0 },
  total: { receipts: 37, unapplied: 2691024 },
  agentTools: [
    { postingAgent: 'mcp:bulk_allocate_bank_transactions:v1', receipts: 34, unapplied: 2436024 },
  ],
  caveat: 'An mcp: stamp proves an agent. Everything else with a journal is reported as "not stamped as an agent".',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getUnappliedReceiptOrigins).mockResolvedValue(ORIGINS);
});

describe('apply_receipt_to_invoice — request shape', () => {
  it('refuses when neither source is named', async () => {
    const r = await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY }, ctx());
    expect(errText(r)).toMatch(/exactly one of payment_id or bank_transaction_id/i);
  });

  it('refuses when BOTH sources are named', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: PAYMENT, bank_transaction_id: TX },
      ctx(),
    );
    expect(errText(r)).toMatch(/exactly one of/i);
    expect(planReceiptApplication).not.toHaveBeenCalled();
    expect(validateBankReceiptApplication).not.toHaveBeenCalled();
  });

  it('refuses a malformed id before it reaches a ::UUID cast', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: 'not-a-uuid' },
      ctx(),
    );
    expect(errText(r)).toBe('invalid payment_id');
  });

  it('names the offending allocation INDEX rather than making the agent bisect', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      {
        ...KEY,
        payment_id: PAYMENT,
        allocations: [{ invoice_id: INV_A, amount: 600 }, { invoice_id: TX, amount: -5 }],
      },
      ctx(),
    );
    expect(errText(r)).toMatch(/allocations\[1\]\.amount must be a positive number/);
  });

  it('refuses a sub-cent amount that Postgres would round behind the agent', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      { ...KEY, payment_id: PAYMENT, allocations: [{ invoice_id: INV_A, amount: 10.005 }] },
      ctx(),
    );
    expect(errText(r)).toMatch(/two decimal places/i);
  });

  it('refuses the same invoice twice in one call', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      {
        ...KEY,
        payment_id: PAYMENT,
        allocations: [{ invoice_id: INV_A, amount: 1 }, { invoice_id: INV_A, amount: 2 }],
      },
      ctx(),
    );
    expect(errText(r)).toMatch(/appears more than once/i);
  });
});

describe('apply_receipt_to_invoice — payment source', () => {
  it('applies and reports every balance that moved', async () => {
    vi.mocked(planReceiptApplication).mockResolvedValue(plan());
    vi.mocked(applyReceiptPlan).mockResolvedValue(plan());

    const out = parseOk(
      await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx()),
    );
    expect(out.source).toBe('payment');
    expect(out.journal_posted).toBe(false);
    expect(out.posted_journal_entry_id).toBeNull();
    expect(out.applied_now).toBe(600);
    expect(out.unapplied_remainder).toBe(400);
    expect(out.invoices).toEqual([{
      invoice_id: INV_A,
      invoice_number: 'INV0001',
      amount_applied: 600,
      outstanding_before: 600,
      outstanding_after: 0,
      status_before: 'approved',
      status_after: 'paid',
    }]);
    expect(vi.mocked(planReceiptApplication).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('a payment_id dry run refuses up front: the live call needs a prepared intent', async () => {
    const r = await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: PAYMENT, dry_run: true },
      ctx(),
    );
    expect(errText(r)).toMatch(/prepared cash application intent and independent approval are required/i);
    expect(planReceiptApplication).not.toHaveBeenCalled();
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('the live call still refuses where its plan refuses', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(
      new Error('Allocations total R900.00 but only R400.00 of this receipt is unapplied'),
    );
    const r = await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx());
    expect(errText(r)).toMatch(/only R400\.00 of this receipt is unapplied/);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
  });

  it('a pre-write refusal is a toolError; a POST-write failure THROWS', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValueOnce(new Error('Invoice X not found'));
    expect(errText(
      await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx()),
    )).toMatch(/not found/i);

    vi.mocked(planReceiptApplication).mockResolvedValue(plan());
    vi.mocked(applyReceiptPlan).mockRejectedValue(new Error('deadlock detected'));
    // Not caught. The savepoint unwinds on a throw and not on a returned error,
    // and a returned refusal would free the key for a retry that applies twice.
    await expect(
      applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx()),
    ).rejects.toThrow(/deadlock/);
  });

  it('does not leak a driver error message into the refusal', async () => {
    const pgErr = Object.assign(new Error('relation "customer_payments" does not exist'), {
      code: '42P01',
    });
    vi.mocked(planReceiptApplication).mockRejectedValue(pgErr);
    const text = errText(
      await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx()),
    );
    expect(text).not.toMatch(/relation|42P01/);
    expect(text).toMatch(/Could not apply this receipt/);
  });
});

describe('apply_receipt_to_invoice — bank transaction source', () => {
  const validation = {
    bankTxId: TX,
    receiptAmount: 1000,
    transactionDate: '2026-03-01',
    customerId: CUSTOMER,
    lines: [LINE],
    allocatedTotal: 600,
    unappliedRemainder: 400,
  };

  it('previews the journal that would post for the FULL bank line', async () => {
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(validation);
    const r = await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, bank_transaction_id: TX, dry_run: true },
      ctx(),
    );
    const out = parseOk(r) as { journals: Array<{ totalDebit: number; date: string }> };
    expect(r.wroteNothing).toBe(true);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
    expect(out.journals).toHaveLength(1);
    // The full line, not the allocated total — that is the whole point.
    expect(out.journals[0]!.totalDebit).toBe(1000);
    expect(out.journals[0]!.date).toBe('2026-03-01');
  });

  it('STAMPS mcp:apply_receipt_to_invoice:v1 on the posting', async () => {
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(validation);
    vi.mocked(confirmReceiptMatch).mockResolvedValue({
      ...validation,
      journalEntryId: 'je-1',
      customerPaymentId: PAYMENT,
      paymentStatus: 'confirmed',
    });

    const out = parseOk(
      await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, bank_transaction_id: TX }, ctx()),
    );
    expect(vi.mocked(confirmReceiptMatch).mock.calls[0]![1].postingAgent)
      .toBe('mcp:apply_receipt_to_invoice:v1');
    expect(out.journal_posted).toBe(true);
    expect(out.posted_journal_entry_id).toBe('je-1');
    expect(out.unapplied_remainder).toBe(400);
  });

  it('refuses pre-write and does not call the posting service', async () => {
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(
      new Error('Bank transaction is "allocated" and cannot be allocated.'),
    );
    expect(errText(
      await applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, bank_transaction_id: TX }, ctx()),
    )).toMatch(/cannot be allocated/);
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('RETHROWS a failure from confirmReceiptMatch rather than returning it', async () => {
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(validation);
    vi.mocked(confirmReceiptMatch).mockRejectedValue(new Error('period closed'));
    await expect(
      applyReceiptToInvoiceTool.handler({ ...ALLOC, ...KEY, bank_transaction_id: TX }, ctx()),
    ).rejects.toThrow(/period closed/);
  });
});

describe('apply_receipt_to_invoice — the two paths must not diverge', () => {
  const validation = {
    bankTxId: TX,
    receiptAmount: 1000,
    transactionDate: '2026-03-01',
    customerId: CUSTOMER,
    lines: [LINE],
    allocatedTotal: 600,
    unappliedRemainder: 400,
  };

  it('the payment dry run refuses while the bank dry run previews — each matches its live call', async () => {
    const fromPayment = await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: PAYMENT, dry_run: true }, ctx(),
    );
    expect(errText(fromPayment)).toMatch(/prepared cash application intent/i);

    vi.mocked(validateBankReceiptApplication).mockResolvedValue(validation);
    const fromBank = parseOk(await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, bank_transaction_id: TX, dry_run: true }, ctx(),
    ));
    expect(fromBank.dryRun).toBe(true);
    expect((fromBank.journals as unknown[]).length).toBe(1);
  });

  it('BOTH LIVE PATHS RETURN THE SAME REPLY KEYS', async () => {
    vi.mocked(planReceiptApplication).mockResolvedValue(plan());
    vi.mocked(applyReceiptPlan).mockResolvedValue(plan());
    const fromPayment = parseOk(await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx(),
    ));

    vi.mocked(validateBankReceiptApplication).mockResolvedValue(validation);
    vi.mocked(confirmReceiptMatch).mockResolvedValue({
      ...validation, journalEntryId: 'je-1', customerPaymentId: PAYMENT, paymentStatus: 'confirmed',
    });
    const fromBank = parseOk(await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, bank_transaction_id: TX }, ctx(),
    ));

    const shared = ['source', 'posted_journal_entry_id', 'journal_posted', 'payment_id',
      'customer_id', 'applied_now', 'unapplied_remainder', 'payment_status', 'invoices'];
    for (const key of shared) {
      expect(fromPayment).toHaveProperty(key);
      expect(fromBank).toHaveProperty(key);
    }
    // And each invoice row is described identically on both.
    expect(Object.keys((fromPayment.invoices as Record<string, unknown>[])[0]!).sort())
      .toEqual(Object.keys((fromBank.invoices as Record<string, unknown>[])[0]!).sort());
  });

  it('A CROSS-TENANT INVOICE IS REFUSED ON BOTH PATHS, with the same generic wording', async () => {
    vi.mocked(planReceiptApplication).mockRejectedValue(new Error(`Invoice ${INV_A} not found`));
    const a = errText(await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, payment_id: PAYMENT }, ctx(),
    ));
    vi.mocked(validateBankReceiptApplication).mockRejectedValue(
      new Error(`Invoice ${INV_A} not found`),
    );
    const b = errText(await applyReceiptToInvoiceTool.handler(
      { ...ALLOC, ...KEY, bank_transaction_id: TX }, ctx(),
    ));
    expect(a).toBe(b);
    expect(applyReceiptPlan).not.toHaveBeenCalled();
    expect(confirmReceiptMatch).not.toHaveBeenCalled();
  });

  it('THE ARGUMENT GUARDS FIRE IDENTICALLY WHICHEVER SOURCE IS NAMED', async () => {
    for (const source of [{ payment_id: PAYMENT }, { bank_transaction_id: TX }]) {
      expect(errText(await applyReceiptToInvoiceTool.handler(
        { ...KEY, ...source, allocations: [{ invoice_id: INV_A, amount: -1 }] }, ctx(),
      ))).toMatch(/allocations\[0\]\.amount must be a positive number/);

      expect(errText(await applyReceiptToInvoiceTool.handler(
        { ...KEY, ...source, allocations: [] }, ctx(),
      ))).toMatch(/non-empty array/);

      expect(errText(await applyReceiptToInvoiceTool.handler(
        {
          ...KEY, ...source,
          allocations: [{ invoice_id: INV_A, amount: 1 }, { invoice_id: INV_A, amount: 1 }],
        }, ctx(),
      ))).toMatch(/appears more than once/);
    }
    expect(planReceiptApplication).not.toHaveBeenCalled();
    expect(validateBankReceiptApplication).not.toHaveBeenCalled();
  });

  it('a MULTI-INVOICE bank allocation is supported, not silently truncated', async () => {
    // One receipt routinely pays several invoices. The whole line posts ONE
    // journal and every allocation is applied; over-allocating past the line is
    // refused by validateBankReceiptApplication rather than being clipped.
    const twoLines = {
      ...validation,
      lines: [LINE, { ...LINE, invoiceId: '4b444444-4444-4444-8444-444444444444', invoiceNumber: 'INV0002', amount: 400 }],
      allocatedTotal: 1000,
      unappliedRemainder: 0,
    };
    vi.mocked(validateBankReceiptApplication).mockResolvedValue(twoLines);
    vi.mocked(confirmReceiptMatch).mockResolvedValue({
      ...twoLines, journalEntryId: 'je-1', customerPaymentId: PAYMENT, paymentStatus: 'reconciled',
    });
    const out = parseOk(await applyReceiptToInvoiceTool.handler({
      ...KEY,
      bank_transaction_id: TX,
      allocations: [
        { invoice_id: INV_A, amount: 600 },
        { invoice_id: '4b444444-4444-4444-8444-444444444444', amount: 400 },
      ],
    }, ctx()));
    expect(out.invoices).toHaveLength(2);
    expect(out.applied_now).toBe(1000);
    // ONE journal for the whole line, not one per invoice.
    expect(vi.mocked(confirmReceiptMatch).mock.calls[0]![1].allocations).toHaveLength(2);
  });
});

describe('suggest_receipt_matches', () => {
  it('returns the shortlist and states how many invoices were considered', async () => {
    vi.mocked(getReceiptMatchCandidates).mockResolvedValue({
      candidates: [{ type: 'customer_invoice', id: INV_A, label: 'X', amount: 600, date: '2026-03-01', score: 120 }],
      poolConsidered: 50,
      scoredTotal: 50,
    } as Awaited<ReturnType<typeof getReceiptMatchCandidates>>);

    const out = parseOk(await suggestReceiptMatchesTool.handler({ bank_transaction_id: TX }, ctx()));
    expect(out.rowsReturned).toBe(1);
    expect(out.rowsTotal).toBe(50);
    // Five of fifty must not read as five of five.
    expect(out.truncated).toBe(true);
    expect(out.completenessFault).toBeUndefined();
    expect(out.next_cursor).toBeNull();
    expect(vi.mocked(getReceiptMatchCandidates).mock.calls[0]![1]).toBe(COMPANY);
  });

  it('is read-only and posts nothing', () => {
    expect(suggestReceiptMatchesTool.write).toBe(false);
    expect(suggestReceiptMatchesTool.requiresPost).toBeUndefined();
  });

  it('refuses a malformed id before the ::UUID cast', async () => {
    expect(errText(await suggestReceiptMatchesTool.handler({ bank_transaction_id: 'x' }, ctx())))
      .toBe('invalid bank_transaction_id');
    expect(getReceiptMatchCandidates).not.toHaveBeenCalled();
  });
});

describe('list_unapplied_receipts', () => {
  const row = {
    paymentId: PAYMENT,
    paymentNumber: 'RCP0001',
    paymentDate: '2026-03-01',
    customerId: CUSTOMER,
    customerName: 'Acme',
    receiptAmount: 1000,
    allocatedAmount: 0,
    unappliedAmount: 1000,
    status: 'confirmed',
    reference: 'REF1',
    description: null,
    journalEntryId: 'je-1',
  };

  it('REPORTS AN ORPHANED RECEIPT IN excludedRows WITH ITS AMOUNT, never dropping it', async () => {
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      rows: [row],
      rowsTotal: 1,
      universeTotal: 2,
      unattributed: [{ ...row, paymentId: TX, customerId: null, customerName: null, unappliedAmount: 250 }],
      totalUnapplied: 1000,
      totalUnattributed: 250,
      postedThrough: '2026-03-02T10:00:00.000Z',
    });

    const out = parseOk(await listUnappliedReceiptsTool.handler({ as_at: '2026-03-31' }, ctx()));
    expect(out.excludedRows).toEqual([{
      id: TX,
      reason: 'unknown_counterparty',
      detail: 'The customer this receipt names no longer exists or has been deleted.',
      amount: 250,
      documentNumber: 'RCP0001',
    }]);
    // 1 included + 1 excluded === a universe of 2. The arithmetic holds, so no
    // fault — that is what makes completeness checkable rather than asserted.
    expect(out.completenessFault).toBeUndefined();
    expect(out.totalUnapplied).toBe(1000);
    expect(out.totalUnattributed).toBe(250);
    expect(out.posted_through).toBe('2026-03-02T10:00:00.000Z');
    expect(out.as_at).toBe('2026-03-31');
  });

  it('raises a completeness fault when rows do not account for the universe', async () => {
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      rows: [row],
      rowsTotal: 1,
      universeTotal: 9,
      unattributed: [],
      totalUnapplied: 1000,
      totalUnattributed: 0,
      postedThrough: '2026-03-02T10:00:00.000Z',
    });
    const out = parseOk(await listUnappliedReceiptsTool.handler({}, ctx()));
    expect(out.completenessFault).toMatch(/8 unaccounted/);
  });

  it('SPLITS THE TOTAL BY WHO CREATED IT, and names the tool that is filling it', async () => {
    // The bucket is not historical: allocating a bank line to a customer posts
    // the journal, creates the receipt and applies it to nothing, so every
    // allocation adds to this total. A reader given only the total goes looking
    // for a cause that is not there.
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      rows: [row], rowsTotal: 1, universeTotal: 1, unattributed: [],
      totalUnapplied: 2691024, totalUnattributed: 0,
      postedThrough: '2026-03-02T10:00:00.000Z',
    });
    const out = parseOk(await listUnappliedReceiptsTool.handler({}, ctx())) as {
      origins: Record<string, unknown>;
    };
    expect(out.origins.agent).toEqual({ receipts: 34, unapplied: 2436024 });
    expect(out.origins.agent_tools).toEqual([
      { posting_agent: 'mcp:bulk_allocate_bank_transactions:v1', receipts: 34, unapplied: 2436024 },
    ]);
    // Never labelled "human": a human stamp proves nothing.
    expect(out.origins).toHaveProperty('not_stamped_as_agent');
    expect(out.origins).not.toHaveProperty('human');
    expect(out.origins.no_journal).toEqual({ receipts: 0, unapplied: 0 });
    expect(String(out.origins.caveat)).toMatch(/not stamped as an agent/i);
    expect(vi.mocked(getUnappliedReceiptOrigins).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('summary returns totals and no rows', async () => {
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      rows: [row],
      rowsTotal: 1,
      universeTotal: 1,
      unattributed: [],
      totalUnapplied: 1000,
      totalUnattributed: 0,
      postedThrough: '2026-03-02T10:00:00.000Z',
    });
    const out = parseOk(await listUnappliedReceiptsTool.handler({ detail: 'summary' }, ctx()));
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.totalUnapplied).toBe(1000);
  });

  it('refuses an invalid cursor rather than throwing inside a read transaction', async () => {
    expect(errText(await listUnappliedReceiptsTool.handler({ cursor: '!!!' }, ctx())))
      .toBe('invalid cursor');
    expect(getUnappliedReceipts).not.toHaveBeenCalled();
  });

  it('refuses an impossible calendar date before it reaches a ::DATE cast', async () => {
    expect(errText(await listUnappliedReceiptsTool.handler({ as_at: '2026-02-31' }, ctx())))
      .toBe('invalid as_at');
  });

  it('passes companyId from ctx, never from args', async () => {
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      rows: [], rowsTotal: 0, universeTotal: 0, unattributed: [],
      totalUnapplied: 0, totalUnattributed: 0, postedThrough: '2026-03-02T10:00:00.000Z',
    });
    await listUnappliedReceiptsTool.handler({}, ctx());
    expect(vi.mocked(getUnappliedReceipts).mock.calls[0]![0]).toBe(COMPANY);
  });
});
