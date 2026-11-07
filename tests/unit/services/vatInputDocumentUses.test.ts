import { describe, expect, it } from 'vitest';
import { judgeBankDocuments, overClaimedClaimDocument, type DocumentUse } from '@/modules/accounting/services/reports/vatInputDocumentUses';

const use = (vat: DocumentUse['vat'], total: number, own: number): DocumentUse => ({ vat, total, own });

describe('judgeBankDocuments: a bank line\'s captured documents as uses', () => {
  it('no document with VAT read leaves the verdict to presence', () => {
    expect(judgeBankDocuments([], 15)).toBeNull();
    expect(judgeBankDocuments([use(null, 15, 15)], 15)).toBeNull();
    expect(judgeBankDocuments([use(0, 15, 15)], 15)).toBeNull();
  });

  it('a claim within what the document has left is supported, to the cent', () => {
    expect(judgeBankDocuments([use(15, 15, 15)], 15)).toEqual({ kind: 'supported' });
    expect(judgeBankDocuments([use(15, 15.004, 15.004)], 15.004)).toEqual({ kind: 'supported' });
    expect(judgeBankDocuments([use(30, 30, 15)], 15)).toEqual({ kind: 'supported' });
  });

  it('another claim on the same document past its VAT is over_claimed, with the figures', () => {
    expect(judgeBankDocuments([use(15, 30, 15)], 15)).toEqual({ kind: 'over_claimed', documentVat: 15, documentClaimedVat: 30 });
  });

  it('another claim under a cent does not count', () => {
    expect(judgeBankDocuments([use(15, 15.004, 15)], 15)).toEqual({ kind: 'supported' });
  });

  it('a lone document short of the claim is a mismatch; an unreadable one beside it makes it a warning', () => {
    expect(judgeBankDocuments([use(10, 15, 15)], 15)).toEqual({ kind: 'mismatch', documentVat: 10, documentClaimedVat: 15 });
    expect(judgeBankDocuments([use(10, 15, 15), use('unreadable', 15, 15)], 15)).toEqual({ kind: 'unreadable' });
    expect(judgeBankDocuments([use('unreadable', 15, 15)], 15)).toEqual({ kind: 'unreadable' });
  });

  it('two documents add up: a free one covers what a used one cannot', () => {
    expect(judgeBankDocuments([use(15, 30, 15), use(15, 15, 15)], 15)).toEqual({ kind: 'supported' });
    expect(judgeBankDocuments([use(15, 30, 15), use(10, 15, 15)], 15).kind).toBe('over_claimed');
  });
});

describe('overClaimedClaimDocument: an expense claim line\'s slip that other claims also use', () => {
  it('flags a slip whose uses exceed its VAT only when another claim shares it', () => {
    expect(overClaimedClaimDocument([use(15, 30, 15)])).toEqual(use(15, 30, 15));
    expect(overClaimedClaimDocument([use(15, 20, 20)])).toBeNull(); // the claim's own mismatch is not this rule's
    expect(overClaimedClaimDocument([use(30, 30, 15)])).toBeNull();
    expect(overClaimedClaimDocument([use(15, 15.004, 15)])).toBeNull();
    expect(overClaimedClaimDocument([use(null, 30, 15), use('unreadable', 30, 15)])).toBeNull();
  });
});
