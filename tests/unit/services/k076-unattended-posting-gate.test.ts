/**
 * K-076 — a slip posts unattended only when nothing on it is left to choose.
 *
 * Four rounds tried to PICK the payable out of several printed totals, and each
 * picking rule was beaten by a slip it had not been shown — the last one read
 * R230.00 off a mixed basket whose VAT analysis is printed under the tender,
 * against a payable of R253.00. So the question changed: extraction still
 * offers a best guess, and `unattendedPostingRefusal` decides whether anybody
 * has to look at it. Every slip in `k076-slip-corpus` goes through the real
 * text extraction and the real gate, and each one must either refuse or post
 * exactly what it asks to be paid.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { extractFromText } from '@/modules/accounting/services/core/ocrService';
import {
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import { unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';
import { SLIPS } from './k076-slip-corpus';

const AUTO_POST = { maxAmount: 5000, minConfidence: 0.85 };
const ACCOUNTS = { expenseAccountId: 'EXP', vatInputAccountId: 'VAT', bankAccountId: 'BANK' };

describe('K-076 every known slip refuses, or posts exactly its payable', () => {
  it.each(SLIPS.map((s) => [s.name, s] as const))('%s', async (_name, slip) => {
    const doc = await extractFromText(slip.text);
    const posts = shouldAutoPostReceipt(doc, AUTO_POST);

    if (posts) {
      // The invariant — never a wrong number, never a refund booked as a purchase.
      expect(slip.payable).not.toBeNull();
      expect(doc.totalAmount).toBe(slip.payable);
      const lines = buildExpenseJournalFromReceipt(doc, ACCOUNTS).lines;
      expect(lines.find((l) => l.accountId === 'BANK')!.credit).toBe(slip.payable);
      // And never more input tax than the slip prints: a null VAT used to be
      // replaced with 15% of the total.
      expect(lines.find((l) => l.accountId === 'VAT')!.debit).toBeLessThanOrEqual(doc.vatAmount!);
    }
    // The outcome is pinned as well, so an over-refusal is as visible as a
    // wrong post.
    expect(posts ? 'post' : 'refuse').toBe(slip.outcome);
  });
});

/** An extraction as the routes read it from `captured_documents.extracted_data`. */
const stored = (overrides: Partial<ExtractedDocument>): ExtractedDocument => ({
  documentType: 'invoice', vendorName: 'Waltons Stationery', vendorVatNumber: null,
  vendorAddress: null, vendorBankDetails: null, customerName: null, customerVatNumber: null,
  date: '2026-09-01', dueDate: null, paymentTerms: null, referenceNumber: 'INV-1',
  purchaseOrderRef: null, currency: 'ZAR', subtotal: 1000, vatAmount: 150, vatRate: 15,
  totalAmount: 1150, lineItems: [], rawText: 'Sub Total 1000.00\nVAT 150.00\nTotal 1150.00',
  confidence: 0.95, warnings: [], extractionMethod: 'vlm',
  ...overrides,
});

describe('K-076 the gate judges the stored document, whatever read it', () => {
  it('posts a VLM extraction whose text prints the one total it read', () => {
    expect(unattendedPostingRefusal(stored({}))).toBeNull();
    expect(shouldAutoPostReceipt(stored({}), AUTO_POST)).toBe(true);
  });

  it('refuses a photo the VLM read directly — nothing shows it is unambiguous', () => {
    expect(unattendedPostingRefusal(stored({ rawText: '' }))).toMatch(/no printed total/);
  });

  it('refuses an extraction stored before this gate existed, by re-reading its text', () => {
    // The round-9 reading of the VAT-analysis slip: 230 / 200 / 30 and no
    // warning. The stored fields agree with each other; the text does not.
    const text = 'TOTAL 253.00\nCASH 300.00\nCHANGE 47.00\nVAT ANALYSIS\nSub Total 200.00\nVAT 15% 30.00\nTotal 230.00';
    const doc = stored({ subtotal: 200, vatAmount: 30, totalAmount: 230, rawText: text });
    expect(unattendedPostingRefusal(doc)).toMatch(/2 different totals/);
  });

  it('refuses when the total read is not the one the text prints', () => {
    const doc = stored({ subtotal: null, vatAmount: 143.48, totalAmount: 1100 });
    expect(unattendedPostingRefusal(doc)).toMatch(/not the total the document prints/);
  });

  it('refuses a net and VAT that do not add up, whoever reported them', () => {
    // The VLM names this "Amount mismatch", a warning the reconciliation prefix
    // does not cover — so the arithmetic is checked here, not the wording.
    const doc = stored({ totalAmount: 1160, rawText: 'Total 1160.00', warnings: ['Amount mismatch'] });
    expect(unattendedPostingRefusal(doc)).toMatch(/do not add up/);
  });

  it('refuses a negative VAT on a positive total even with no net printed', () => {
    const doc = stored({ subtotal: null, vatAmount: -150, totalAmount: 1150, rawText: 'VAT:-150.00\nTotal 1150.00' });
    expect(unattendedPostingRefusal(doc)).toMatch(/negative/);
  });

  it('refuses a credit note by its stored classification alone', () => {
    expect(unattendedPostingRefusal(stored({ documentType: 'credit_note' }))).toMatch(/credit note/);
  });

  it('refuses a credit note by its text when the classification says invoice', () => {
    const doc = stored({ rawText: 'CREDIT NOTE\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00' });
    expect(unattendedPostingRefusal(doc)).toMatch(/credit note/);
  });
});
