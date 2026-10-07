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

  // R-035 PR5 addendum: a payment's or batch's refusal names the payment or
  // batch, never a bill, and its way out works — the bills' author creates
  // the payment themselves, so a member who captured nothing may approve it.
  it.each([['supplier_payment', 'payment'], ['payment_batch', 'batch']])('%s: names the %s and gives its way out', async (type, doc) => {
    expect(await deadEnd(type)).toBe(
      `You cannot approve this request: you authored the content it covers (you created the ${doc}, merged a supplier `
      + "it pays, set a payee's current bank details or changed them while it was unpaid, or captured or edited a bill it "
      + 'pays). No eligible approver remains: every member with the owner role or above either authored the content or '
      + `raised the request. Cancel the ${doc} and have the author of the bills it pays create it themselves, so another `
      + "eligible approver — one who did not set the payee's bank details — can approve it, or have someone with the owner "
      + 'role or above who did not author it approve it.');
  });

  // R-035 PR6: a manual journal's refusal names the journal and its way out —
  // it has no edit route, so the recurring template's author runs it themselves.
  it('manual_journal: names the journal and gives its way out', async () => {
    expect(await deadEnd('manual_journal')).toBe(
      'You cannot approve this request: you authored the content it covers (you created the journal, merged an account '
      + 'its lines name, or created or edited the recurring template it was generated from). No eligible approver '
      + 'remains: every member with the owner role or above either authored the content or raised the request. Have the '
      + 'author of the recurring template it came from generate it themselves, so another eligible approver can approve '
      + 'the journal, or have someone with the owner role or above who did not author it approve it.');
  });
});
