/**
 * R-035 PR4 round 2 (Hein, 2026-10-06, decision 1): the content-author refusal
 * names the document it is about. For a customer invoice it says "invoice", not
 * "bill", and gives the way out of the accepted dead end — every member of the
 * rank authored the content or raised the request (two owners: one priced the
 * quote, the other converted it): have the author of the source perform the
 * conversion or run, so another eligible approver can approve. The supplier
 * invoice and credit-note texts are unchanged, byte for byte.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { contentAuthorRefusal } from '@/modules/accounting/services/gl/approvalAuthors';

const OWNER = (id: string) => ({ user_id: id, role: 'owner', is_active: true, status: 'active', suspended_at: null });
const qualifies = (role: string) => role === 'owner';

/** Two owners: A (the decider, an author) and R (the requester, also an author). Nobody else is left. */
async function deadEnd(documentType?: string): Promise<string | null> {
  vi.mocked(sql).mockResolvedValueOnce([OWNER('R')] as never);
  return contentAuthorRefusal('c', 'A', {
    requester: 'R', liveAuthors: ['A', 'R'], snapshotAuthors: [], wasRequester: false,
    deciderRole: 'owner', enforced: true, documentType,
  } as never, 'owner', qualifies);
}

const OLD = 'You cannot approve this request: you authored the content it covers (you created the document or made an '
  + 'edit that changed it). No eligible approver remains: every member with the owner role or above either authored the '
  + 'content or raised the request. Cancel and re-enter the bill, or have someone with the owner role or above who did '
  + 'not author it approve it.';

beforeEach(() => { vi.mocked(sql).mockReset(); });

describe('the content-author refusal names its document', () => {
  it.each(['supplier_invoice', 'customer_credit_note', 'supplier_credit_note'])('%s: unchanged, byte for byte', async (type) => {
    expect(await deadEnd(type)).toBe(OLD);
  });

  it('customer_invoice: says invoice, never bill, and how to get out of the dead end', async () => {
    const text = (await deadEnd('customer_invoice'))!;
    expect(text).not.toMatch(/\bbill\b/);
    expect(text).toMatch(/you created the invoice/);
    expect(text).toMatch(/have the author of the source \(quote, sales order or recurring template\) perform the conversion or run/i);
    expect(text).toMatch(/so another eligible approver can approve/);
  });
});
