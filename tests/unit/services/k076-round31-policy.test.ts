/**
 * Round 31 (review of `eb7f54a5f`, 1M/3L).
 *
 * MEDIUM: the receipt builder derived 15/115 of the total as VAT Input when no
 * VAT was read (the DB side, the claim branch and MCP `post_journal` are in
 * `k072-receipt-vat-unread.int.test.ts`). LOW-1: a legend or `0%` term voided
 * rule (b)'s arithmetic exemption; only a marked ITEM line may. LOW-2: the
 * unmarked coincidence is a DISCLOSED RESIDUAL, pinned as open so a change to
 * it is seen. The reviewer's inputs.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { buildExpenseJournalFromReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const IDS = { expenseAccountId: 'exp', vatInputAccountId: 'vat', bankAccountId: 'bank' };

describe('K-076 r31 MEDIUM — the receipt builder never invents a VAT', () => {
  const slip = (vat: Partial<ExtractedDocument>) =>
    ({ vendorName: 'Joe Garden Services', date: '2026-09-01', totalAmount: 1000, lineItems: [], ...vat }) as ExtractedDocument;

  it.each([{ vatAmount: null, subtotal: null }, { vatAmount: null, subtotal: 869.57 }, { vatAmount: undefined, subtotal: undefined }])(
    'no VAT read (%j): no VAT Input, the gross on the expense, unclassified, flagged', (vat) => {
      const j = buildExpenseJournalFromReceipt(slip(vat as Partial<ExtractedDocument>), IDS);
      expect(j.lines.find((l) => l.accountId === 'vat')!.debit).toBe(0);
      expect(j.lines.find((l) => l.accountId === 'exp')).toMatchObject({ debit: 1000, vatType: 'no_vat' });
      expect(j.description).toMatch(/VAT not read from the document, none claimed$/);
    });

  it('a VAT read of 0 claims 0 and is not flagged; a VAT read of 130.43 is kept', () => {
    expect(buildExpenseJournalFromReceipt(slip({ vatAmount: 0, subtotal: 1000 }), IDS).description).not.toMatch(/VAT not read/);
    const j = buildExpenseJournalFromReceipt(slip({ vatAmount: 130.43, subtotal: 869.57 }), IDS);
    expect(j.lines.find((l) => l.accountId === 'vat')!.debit).toBe(130.43);
    expect(j.lines.find((l) => l.accountId === 'exp')).toMatchObject({ debit: 869.57, vatType: 'standard' });
  });
});

const CATERING = (extra: string, where: 'above' | 'below') => 'Greenleaf Catering\nTAX INVOICE\nVAT No 4123450000\nInvoice No: 7781\n'
  + (where === 'above' ? `${extra}\n` : '') + 'Platters 2 @ 575.00 1150.00\nTotal 1150.00\nVAT 15% 150.00\n'
  + (where === 'below' ? `${extra}\n` : '') + 'Bank: FNB 62000000000';
const CK = { subtotal: 1000, vatAmount: 150 };

describe('K-076 r31 LOW-1 — only a marked ITEM line voids the arithmetic exemption', () => {
  it.each(['Items marked Z are zero-rated', '(Z) = Zero Rated', 'E = Exempt', 'Disbursements are not subject to VAT',
    'Settlement discount 0% if paid in 30 days', 'Interest charged at 0% on overdue accounts', 'Nulkoers items gemerk Z',
    'Non-VAT items marked N', '* denotes 0% VAT'])('a legend "%s", above or below the items, voids nothing', (legend) => {
    expect(unreconciledFigure(CATERING(legend, 'below'), 1150, CK)).toBeNull();
    expect(unreconciledFigure(CATERING(legend, 'above'), 1150, CK)).toBeNull();
  });

  it('a zero-rated line BELOW the total is a recap, not an item: `Zero Rated 0.00` voids nothing', () => {
    expect(unreconciledFigure(CATERING('Zero Rated 0.00', 'below'), 1150, CK)).toBeNull();
  });

  it('a marked item line that prices something does void it', () => {
    const text = CATERING('Bread (Z) 150.00', 'above').replace('Platters 2 @ 575.00 1150.00', 'Platters 1000.00');
    expect(unreconciledFigure(text, 1150, CK)).toMatchObject({ reason: 'pretax' });
  });
});

describe('K-076 r31 LOW-2 — DISCLOSED RESIDUAL, pinned as open', () => {
  // A pre-tax total whose no-VAT share lands the VAT within 5 cents of
  // total × 15/115, with no marker anywhere: nothing in the text separates it
  // from an honest inclusive slip, and dropping the exemption refuses ordinary
  // unpaid slips that print `Total / VAT` below. See fix.md round 31.
  it('`Conveyancing fee 1000.00 / Deeds office fee 150.30 / Total 1150.30 / VAT 15% 150.00` still posts', () => {
    const text = 'Mokoena Attorneys\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 0045\nConveyancing fee 1000.00\n'
      + 'Deeds office fee 150.30\nTotal 1150.30\nVAT 15% 150.00\nBanking details: FNB Acc 62812345678';
    expect(unreconciledFigure(text, 1150.3, { subtotal: 1000.3, vatAmount: 150 })).toBeNull();
  });
});
