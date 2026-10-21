/**
 * FB-6 (Hein, 2026-10-20, terms.md option ii): MCP calls made through a
 * marketplace connection, meaning a dynamically registered OAuth client
 * (oauth_apps.is_dynamic), are not billed Flows. PATs and pre-registered
 * OAuth apps keep the existing PAYG metering. Split from flowMetering.test.ts
 * (300-line cap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/billing/services/flowWalletService', () => ({
  deductFlows: vi.fn(),
  refundFlows: vi.fn(),
  triggerAutoTopup: vi.fn(),
  InsufficientFlowsError: class InsufficientFlowsError extends Error {
    balance = 0;
    required = 0;
  },
}));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn() }));
vi.mock('@/lib/auth/oauthDynamicClients', () => ({ isDynamicOauthApp: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { deductFlows, triggerAutoTopup } from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import { isDynamicOauthApp } from '@/lib/auth/oauthDynamicClients';
import { debitForTool } from '@/lib/mcp/flowMetering';
import { insufficientFlowsText } from '@/lib/mcp/flowRefusal';

const COMPANY = 'company-1';
const DYNAMIC_APP = 'app-dynamic-1';
const REGISTERED_APP = 'app-registered-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'payg' } as never);
  vi.mocked(deductFlows).mockResolvedValue({ balanceAfter: 90 } as never);
  vi.mocked(isDynamicOauthApp).mockImplementation(async (id: string) => id === DYNAMIC_APP);
});

describe('debitForTool — marketplace connections are free', () => {
  it('a PAYG write through a dynamically registered OAuth client debits nothing and never tops up', async () => {
    const out = await debitForTool(COMPANY, 'create_draft_invoice', {}, DYNAMIC_APP);
    expect(out).toEqual({ ok: true, handle: null });
    expect(isDynamicOauthApp).toHaveBeenCalledWith(DYNAMIC_APP);
    expect(deductFlows).not.toHaveBeenCalled();
    expect(triggerAutoTopup).not.toHaveBeenCalled();
  });

  it('a pre-registered OAuth app keeps the existing metering', async () => {
    const out = await debitForTool(COMPANY, 'create_draft_invoice', {}, REGISTERED_APP);
    expect(out.ok).toBe(true);
    expect(deductFlows).toHaveBeenCalledTimes(1);
  });

  it('a PAT connection (no OAuth app) keeps the existing metering, without a lookup', async () => {
    for (const appId of [null, undefined]) {
      vi.mocked(deductFlows).mockClear();
      await debitForTool(COMPANY, 'create_draft_invoice', {}, appId as null);
      expect(deductFlows).toHaveBeenCalledTimes(1);
    }
    expect(isDynamicOauthApp).not.toHaveBeenCalled();
  });

  it('never looks the app up for a free tool or a subscription company', async () => {
    await debitForTool(COMPANY, 'trial_balance', {}, DYNAMIC_APP);
    vi.mocked(getCompanyPlan).mockResolvedValue({ planCode: 'professional' } as never);
    await debitForTool(COMPANY, 'create_draft_invoice', {}, DYNAMIC_APP);
    expect(isDynamicOauthApp).not.toHaveBeenCalled();
    expect(deductFlows).not.toHaveBeenCalled();
  });

  it('a lookup failure propagates rather than silently billing or exempting', async () => {
    vi.mocked(isDynamicOauthApp).mockRejectedValue(new Error('db down'));
    await expect(debitForTool(COMPANY, 'create_draft_invoice', {}, DYNAMIC_APP)).rejects.toThrow('db down');
    expect(deductFlows).not.toHaveBeenCalled();
  });
});

describe('insufficientFlowsText — no upsell', () => {
  it('states what is missing and that nothing changed', () => {
    const text = insufficientFlowsText('create_draft_invoice', 3, 1);
    expect(text).toBe(
      "This company's Flow balance is too low for create_draft_invoice: it costs 3 Flows and the balance is 1. Nothing was changed.",
    );
    expect(text).not.toMatch(/top up|upgrade|buy|purchase|plan/i);
  });
});
