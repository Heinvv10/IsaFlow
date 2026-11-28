/** Intercompany P2: a mirror link puts the connection's LOW company's document on side A, whichever company sent the message. */
import { describe, expect, it } from 'vitest';
import { orderLinkDocs } from '@/modules/accounting/services/intercompany/linkOrder';

const source = { type: 'customer_invoice', id: 's' };
const target = { type: 'supplier_invoice', id: 't' };

describe('orderLinkDocs', () => {
  it('a sender that is the LOW company has its document on A and the receiver\'s on B', () => {
    expect(orderLinkDocs(true, source, target)).toEqual({ a: source, b: target });
  });
  it('a sender that is the HIGH company has the receiver\'s document on A and its own on B', () => {
    expect(orderLinkDocs(false, source, target)).toEqual({ a: target, b: source });
  });
});
