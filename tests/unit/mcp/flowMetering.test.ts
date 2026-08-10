// RED phase — written before implementation.
/**
 * PAYG metering for MCP tool calls.
 *
 * The connector shipped 25 tools that bypass Flow metering entirely, while the
 * same operations charge through withFlowMeter in the UI: an agent could pull a
 * trial balance (10 Flows in the app) or create an invoice (3) for free.
 *
 * Rates are UI parity — a tool costs what the equivalent metered endpoint
 * costs, and costs nothing when the UI has no metered equivalent. Corrections
 * are free: charging a company to undo the agent's own mistake is hostile, and
 * it would also discourage using the very controls the safety model rests on.
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
import { flowOperationFor, debitForTool, refundForTool } from '@/lib/mcp/flowMetering';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';

const COMPANY = 'company-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'payg' } as never);
  vi.mocked(deductFlows).mockResolvedValue({ balanceAfter: 90 } as never);
});

describe('flowOperationFor — UI parity map', () => {
  it('charges reports at the same code the metered UI endpoint uses', () => {
    expect(flowOperationFor('trial_balance', {})).toBe('report.tb');
    expect(flowOperationFor('profit_and_loss', {})).toBe('report.pnl');
    expect(flowOperationFor('balance_sheet', {})).toBe('report.bs');
    expect(flowOperationFor('aged_debtors', {})).toBe('report.age');
    expect(flowOperationFor('aged_creditors', {})).toBe('report.age');
    expect(flowOperationFor('vat_status', {})).toBe('vat.return');
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

describe('debitForTool', () => {
  it('charges a PAYG company the catalog cost before the tool runs', async () => {
    const res = await debitForTool(COMPANY, 'trial_balance', {});

    expect(res.ok).toBe(true);
    expect(vi.mocked(deductFlows).mock.calls[0]![1]).toBe(10);
    expect(vi.mocked(deductFlows).mock.calls[0]![2]).toBe('report.tb');
  });

  it('does not charge a subscription company', async () => {
    vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'growth' } as never);

    const res = await debitForTool(COMPANY, 'trial_balance', {});

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
      .mockRejectedValueOnce(new InsufficientFlowsError(2, 10) as never)
      .mockResolvedValueOnce({ balanceAfter: 90 } as never);
    vi.mocked(triggerAutoTopup).mockResolvedValue({ success: true } as never);

    const res = await debitForTool(COMPANY, 'trial_balance', {});

    expect(res.ok).toBe(true);
    expect(deductFlows).toHaveBeenCalledTimes(2);
  });

  it('refuses the call when the wallet is empty and top-up fails', async () => {
    vi.mocked(deductFlows).mockRejectedValue(new InsufficientFlowsError(2, 10) as never);
    vi.mocked(triggerAutoTopup).mockResolvedValue({ success: false } as never);

    const res = await debitForTool(COMPANY, 'trial_balance', {});

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.balance).toBe(2);
      expect(res.required).toBe(10);
    }
  });
});

describe('refundForTool', () => {
  it('returns the exact amount that was debited', async () => {
    await refundForTool(COMPANY, { code: 'report.tb', cost: 10 });

    expect(vi.mocked(refundFlows).mock.calls[0]![1]).toBe(10);
    expect(vi.mocked(refundFlows).mock.calls[0]![2]).toBe('report.tb');
  });

  it('never throws — a failed refund must not turn into a second failure', async () => {
    vi.mocked(refundFlows).mockRejectedValue(new Error('wallet unavailable'));

    await expect(refundForTool(COMPANY, { code: 'report.tb', cost: 10 })).resolves.toBeUndefined();
  });
});
