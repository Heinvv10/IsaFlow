/**
 * R-075 census — the three call sites that keep the bare fire-and-forget.
 *
 * `resolvePendingAlertForInvoice` is called un-awaited from ai-invoice-pipeline,
 * capture/[id]/post and supplierInvoiceService, all three under withAuth. They
 * are NOT R-075 sites: the function has no await before its `sql`, so the
 * UPDATE is queued on the request's client synchronously, ahead of the COMMIT,
 * and commits with the request. Converting them to runAfterCommit would move an
 * atomic write out of the transaction.
 *
 * That claim is a fact about the function's shape, not about its callers, so it
 * is pinned here: put one `await` before the `sql` in alertResolutionService and
 * this file goes red (the query is no longer issued in the transaction, and the
 * finished context refuses it) — see docs/audits/remediation/R-075/fix.md.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { als, type RequestContext } from '@/lib/als';
import { runOwnedContext } from '@/lib/afterCommit';
import { resolvePendingAlertForInvoice } from '@/modules/accounting/services/capture/alertResolutionService';

const ARGS = ['c1', 's1', 'i1', '2026-09-01'] as const;

function makeCtx() {
  const query = vi.fn(async () => ({ rows: [] }));
  const ctx = { client: { query }, userId: 'u1', companyId: 'c1', claims: {}, afterCommit: [] } as unknown as RequestContext;
  return { ctx, query };
}

describe('resolvePendingAlertForInvoice is not an R-075 site', () => {
  it('issues its UPDATE on the request client, ahead of the owner finishing', async () => {
    const { ctx, query } = makeCtx();
    let pending: Promise<unknown> | undefined;
    // Exactly the call sites' shape: started, never awaited, handler returns.
    await runOwnedContext(ctx, async () => { pending = resolvePendingAlertForInvoice(...ARGS); });
    expect(ctx.finished).toBe(true);
    // No await precedes the `sql`, so the statement was already queued on the
    // request's client — ahead of the owner's COMMIT — and is never refused.
    await expect(pending).resolves.toEqual({ resolvedAlertId: null });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toMatch(/UPDATE expected_invoice_alerts/);
  });

  it('and if it ever did await first, the finished context would refuse it', async () => {
    const { ctx, query } = makeCtx();
    ctx.finished = true;
    await als.run(ctx, async () => {
      await expect(resolvePendingAlertForInvoice(...ARGS)).rejects.toThrow(/already finished/);
    });
    expect(query).not.toHaveBeenCalled();
  });
});
