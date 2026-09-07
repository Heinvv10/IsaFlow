// RED phase — written before implementation.
/**
 * PAYG metering for MCP tool calls.
 *
 * The connector shipped 25 tools that bypass Flow metering entirely, while the
 * same operations charge through withFlowMeter in the UI: an agent could pull a
 * trial balance (10 Flows in the app) or create an invoice (3) for free.
 *
 * Pricing is WRITES ONLY. A write costs what the equivalent metered endpoint
 * costs in the app; every read is free. Full UI parity was the first cut and an
 * adversarial review priced it out — 10-Flow reads at the endpoint's 120/min
 * drain a month's budget in under three minutes, from an ordinary retry loop.
 * Corrections stay free too: charging to undo the agent's own mistake is
 * hostile and would discourage using the controls the safety model rests on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(),
  refundFlows: vi.fn(),
  triggerAutoTopup: vi.fn(),
  recalculateNudge: vi.fn(),
  InsufficientFlowsError: class InsufficientFlowsError extends Error {
    balance: number;
    required: number;
    constructor(balance: number, required: number) {
      super('insufficient flows');
      this.balance = balance;
      this.required = required;
    }
  },
}));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  deductFlows,
  refundFlows,
  triggerAutoTopup,
  InsufficientFlowsError,
} from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import {
  flowOperationFor, flowQuantityFor, debitForTool, refundForTool,
} from '@/lib/mcp/flowMetering';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

const COMPANY = 'company-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'payg' } as never);
  vi.mocked(deductFlows).mockResolvedValue({ balanceAfter: 90 } as never);
});

describe('flowOperationFor — writes-only map', () => {
  it('does not charge for reports, unlike the UI — a 10-Flow read at 120/min drains the wallet', () => {
    // 10 Flows x 120 calls/min = 1,200/min; the nudge thresholds top out at
    // 2,900/month, so a month's budget goes in under three minutes, 402s the
    // human UI sharing the wallet, and would drive auto-topup once v2 payment
    // tokens exist. Reads are free on this surface.
    for (const name of [
      'trial_balance', 'profit_and_loss', 'balance_sheet',
      'aged_debtors', 'aged_creditors', 'vat_status',
    ]) {
      expect(flowOperationFor(name, {})).toBeNull();
    }
  });

  it('charges no read tool at all', () => {
    const charged = MCP_TOOLS.filter((t) => !t.write && flowOperationFor(t.name, {}) !== null);
    expect(charged.map((t) => t.name)).toEqual([]);
  });

  it('charges document creation at the UI rate', () => {
    expect(flowOperationFor('create_draft_invoice', {})).toBe('invoice.create');
    expect(flowOperationFor('create_draft_journal', {})).toBe('journal.create');
    expect(flowOperationFor('import_bank_statement', {})).toBe('bank.import');
  });

  it('does not charge twice for one document — finalising a paid draft is free', () => {
    // create_draft_invoice already paid invoice.create; the UI likewise charges
    // on create, not on approve.
    expect(flowOperationFor('finalize_invoice', {})).toBeNull();
    expect(flowOperationFor('post_journal', {})).toBeNull();
  });

  it('never charges for a correction', () => {
    expect(flowOperationFor('reverse_bank_allocation', {})).toBeNull();
    expect(flowOperationFor('undo_bank_import', {})).toBeNull();
  });

  it('does not charge for reads the UI gives away', () => {
    for (const name of [
      'company_profile', 'search_gl', 'list_invoices', 'get_invoice', 'list_quotes',
      'list_customers', 'list_suppliers', 'bank_accounts_status',
      'list_bank_transactions', 'get_match_candidates', 'list_agent_postings',
    ]) {
      expect(flowOperationFor(name, {})).toBeNull();
    }
  });

  it('leaves bank allocation free, matching the UI where bank.allocate is unused', () => {
    expect(flowOperationFor('allocate_bank_transaction', {})).toBeNull();
    expect(flowOperationFor('suggest_bank_allocation', {})).toBeNull();
  });

  it('does not charge a dry run — nothing is written', () => {
    expect(flowOperationFor('import_bank_statement', { dry_run: true })).toBeNull();
    expect(flowOperationFor('import_bank_statement', { dry_run: false })).toBe('bank.import');
  });

  it('has an explicit entry for every registered tool — a new tool must not default to free', () => {
    // The failure this guards is silent: add a tool, forget the map, and it
    // bills nothing forever. The map must name every tool, free or not.
    const unmapped = MCP_TOOLS.map((t) => t.name).filter((n) => flowOperationFor(n, {}) === undefined);
    expect(unmapped).toEqual([]);
  });
});

describe('flowQuantityFor — bulk creates bill per ELEMENT', () => {
  it('is 1 for an ordinary tool, whatever it was sent', () => {
    expect(flowQuantityFor('create_supplier_invoice', {})).toBe(1);
    expect(flowQuantityFor('create_supplier_invoice', { invoices: [1, 2, 3] })).toBe(1);
  });

  // Real payloads, not `Array.from({length: n})`. The AP arm now counts what
  // will be CREATED — it partitions the batch with the same pure function the
  // handler uses — so a placeholder array reads as malformed and bills 1.
  const bill = (n: number) => ({
    supplier_id: '11111111-1111-4111-8111-111111111111',
    invoice_number: `INV-${n}`,
    invoice_date: '2026-03-01',
    lines: [{ description: 'x', quantity: 1, unit_price: 100 }],
  });

  it('is the element count for each bulk create', () => {
    expect(flowQuantityFor('bulk_create_supplier_invoices', {
      invoices: Array.from({ length: 40 }, (_, i) => bill(i)),
    })).toBe(40);
    // The AR arm reserves its own numbers and has no skip, so it still bills
    // straight off the sent count.
    expect(flowQuantityFor('bulk_create_customer_invoices', {
      invoices: Array.from({ length: 40 }),
    })).toBe(40);
  });

  // The defect this closes: skipped elements were billed. A payload of 40
  // carrying 6 identical repeats creates 34 bills and must cost 34 — the
  // refund is all-or-nothing, so an over-debit here is never returned.
  it('bills only what the batch will actually create', () => {
    const invoices = [
      ...Array.from({ length: 34 }, (_, i) => bill(i)),
      ...Array.from({ length: 6 }, (_, i) => bill(i)),
    ];
    expect(invoices).toHaveLength(40);
    expect(flowQuantityFor('bulk_create_supplier_invoices', { invoices })).toBe(34);
  });

  // One number naming two DIFFERENT bills is refused by the handler with
  // nothing written, so it costs the single unit the refund returns.
  it('is 1 for a batch the partition refuses', () => {
    expect(flowQuantityFor('bulk_create_supplier_invoices', {
      invoices: [
        bill(1),
        { ...bill(1), lines: [{ description: 'x', quantity: 1, unit_price: 48500 }] },
      ],
    })).toBe(1);
  });

  it('is CAPPED at the batch maximum — an oversized array must not drain the wallet', () => {
    // The debit is taken before the handler runs and JSON Schema maxItems is
    // advisory, so an uncapped quantity would bill 50,000 invoices before the
    // handler refused the batch as over the maximum.
    // Also proves the oversized array is NOT partitioned: 50,000 placeholder
    // elements would read as malformed and bill 1 if the bound came second.
    expect(flowQuantityFor('bulk_create_supplier_invoices', {
      invoices: Array.from({ length: 50_000 }),
    })).toBe(100);
  });

  it('is 1 for a malformed batch — the handler refuses it and the refund returns that one', () => {
    expect(flowQuantityFor('bulk_create_supplier_invoices', {})).toBe(1);
    expect(flowQuantityFor('bulk_create_supplier_invoices', { invoices: [] })).toBe(1);
    expect(flowQuantityFor('bulk_create_supplier_invoices', { invoices: 'nope' })).toBe(1);
  });
});

describe('debitForTool', () => {
  it('charges a bulk create N times the single tool, not once', async () => {
    // A flat debit would let an agent create 100 bills for the price of one.
    const single = await debitForTool(COMPANY, 'create_supplier_invoice', {});
    expect(single.ok).toBe(true);
    const unit = vi.mocked(deductFlows).mock.calls[0]![1] as number;
    expect(unit).toBeGreaterThan(0);

    vi.mocked(deductFlows).mockClear();
    // Real payloads: the AP arm partitions the batch to count what it will
    // create, so placeholders would read as malformed and bill 1.
    const bulk = await debitForTool(COMPANY, 'bulk_create_supplier_invoices', {
      invoices: Array.from({ length: 7 }, (_, i) => ({
        supplier_id: '11111111-1111-4111-8111-111111111111',
        invoice_number: `INV-${i}`,
        invoice_date: '2026-03-01',
        lines: [{ description: 'x', quantity: 1, unit_price: 100 }],
      })),
    });
    expect(bulk.ok).toBe(true);
    expect(vi.mocked(deductFlows).mock.calls[0]![1]).toBe(unit * 7);
    expect(vi.mocked(deductFlows).mock.calls[0]![2]).toBe('invoice.create');
  });

  it('charges a PAYG company the catalog cost before the tool runs', async () => {
    const res = await debitForTool(COMPANY, 'create_draft_journal', {});

    expect(res.ok).toBe(true);
    expect(vi.mocked(deductFlows).mock.calls[0]![1]).toBe(3);
    expect(vi.mocked(deductFlows).mock.calls[0]![2]).toBe('journal.create');
  });

  it('does not charge a subscription company', async () => {
    vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'growth' } as never);

    const res = await debitForTool(COMPANY, 'create_draft_journal', {});

    expect(res.ok).toBe(true);
    expect(deductFlows).not.toHaveBeenCalled();
  });

  it('does not touch the wallet for a free tool', async () => {
    const res = await debitForTool(COMPANY, 'list_customers', {});

    expect(res.ok).toBe(true);
    expect(deductFlows).not.toHaveBeenCalled();
    expect(getCompanyPlan).not.toHaveBeenCalled();
  });

  it('retries once after a successful auto top-up', async () => {
    vi.mocked(deductFlows)
      .mockRejectedValueOnce(new InsufficientFlowsError(2, 3) as never)
      .mockResolvedValueOnce({ balanceAfter: 90 } as never);
    vi.mocked(triggerAutoTopup).mockResolvedValue({ success: true } as never);

    const res = await debitForTool(COMPANY, 'create_draft_journal', {});

    expect(res.ok).toBe(true);
    expect(deductFlows).toHaveBeenCalledTimes(2);
  });

  it('refuses the call when the wallet is empty and top-up fails', async () => {
    vi.mocked(deductFlows).mockRejectedValue(new InsufficientFlowsError(2, 3) as never);
    vi.mocked(triggerAutoTopup).mockResolvedValue({ success: false } as never);

    const res = await debitForTool(COMPANY, 'create_draft_journal', {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.balance).toBe(2);
      expect(res.required).toBe(3);
    }
  });
});

describe('refundForTool', () => {
  it('returns the exact amount that was debited', async () => {
    await refundForTool(COMPANY, { code: 'journal.create', cost: 3 });

    expect(vi.mocked(refundFlows).mock.calls[0]![1]).toBe(3);
    expect(vi.mocked(refundFlows).mock.calls[0]![2]).toBe('journal.create');
  });

  it('never throws — a failed refund must not turn into a second failure', async () => {
    vi.mocked(refundFlows).mockRejectedValue(new Error('wallet unavailable'));

    await expect(refundForTool(COMPANY, { code: 'journal.create', cost: 3 })).resolves.toBeUndefined();
  });
});
