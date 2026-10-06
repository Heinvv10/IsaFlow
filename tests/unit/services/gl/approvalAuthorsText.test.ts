/**
 * R-035 PR4 round 2 (Hein, 2026-10-06, decision 1): the content-author refusal
 * names the document it is about. For a customer invoice it says "invoice", not
 * "bill", and gives the way out of the accepted dead end — every member of the
 * rank authored the content or raised the request (two owners: one priced the
 * quote, the other converted it): have the author of the source perform the
 * conversion, run or invoicing themselves, so another eligible approver can
 * approve (round 4: never "leave it to another member" — the invoicer is an
 * author too). The supplier invoice and credit-note texts are unchanged, byte
 * for byte.
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

  it('customer_invoice: says invoice, never bill, and gives the way out that works', async () => {
    // Round 4: the way out is that a source's author performs the step that
    // makes the invoice themselves — the invoicer is an author of the invoice
    // too, so telling a time-entry re-pricer to leave the invoicing to another
    // member only re-made the dead end.
    expect(await deadEnd('customer_invoice')).toBe(
      'You cannot approve this request: you authored the content it covers (you created the invoice, made an edit '
      + 'that changed it, or wrote or re-priced the quote, sales order, time entry or recurring template it came from). '
      + 'No eligible approver remains: every member with the owner role or above either authored the content or raised '
      + 'the request. Have the author of the source — the quote, sales order or recurring template, or whoever set the '
      + 'rate or hours of a time entry it bills — perform the conversion, run or invoicing themselves, so another '
      + 'eligible approver can approve the invoice, or have someone with the owner role or above who did not author it '
      + 'approve it.');
  });
});
