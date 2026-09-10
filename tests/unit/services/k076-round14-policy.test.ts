/**
 * K-072 round 14 — the fallback never posts unattended, and a credit never
 * posts as a purchase.
 *
 * Five review rounds each beat the "is this free text unambiguous" classifier
 * with a realistic slip, so the policy changed: figures the regex/OCR fallback
 * recovered go to a person on every path, however clean the slip looks. Only a
 * structured VLM extraction that also passes the unambiguity gate may post or
 * approve unattended — and never one carrying a credit, refund or return
 * indicator.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { extractFromText } from '@/modules/accounting/services/core/ocrService';
import { shouldAutoPostReceipt } from '@/modules/accounting/services/bank/receiptToJournalService';
import {
  isCreditNote,
  refusesUnattendedApproval,
  unattendedPostingRefusal,
} from '@/modules/accounting/services/core/unattendedPostingGate';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { adjustmentAfterTotal, unexplainedLargerFigure } from '@/modules/accounting/services/core/ocrLargerFigure';

const AUTO_POST = { maxAmount: 5000, minConfidence: 0.85 };
const CLEAN = 'Waltons Stationery\nTAX INVOICE\nVAT No 4987654321\nDate: 2026-09-01\nInvoice No: 55123\n'
  + 'Copy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00';

describe('K-072 round 14 — fallback figures never decide money unattended', () => {
  it('refuses a fallback extraction that passes every other check', async () => {
    const fallback = await extractFromText(CLEAN);
    expect(fallback.extractionMethod).toBe('regex');
    expect(unattendedPostingRefusal(fallback)).toMatch(/text fallback/);
    expect(shouldAutoPostReceipt(fallback, AUTO_POST)).toBe(false);
    expect(refusesUnattendedApproval(fallback)).toBe(true);
    // The guess is still offered to the person who confirms it.
    expect(fallback.totalAmount).toBe(1150);
  });

  it('still posts and approves the same figures read by the VLM', async () => {
    const vlm: ExtractedDocument = { ...(await extractFromText(CLEAN)), extractionMethod: 'vlm' };
    expect(unattendedPostingRefusal(vlm)).toBeNull();
    expect(shouldAutoPostReceipt(vlm, AUTO_POST)).toBe(true);
    expect(refusesUnattendedApproval(vlm)).toBe(false);
  });

  it('treats a stored extraction with no method, or a mixed one, as fallback', async () => {
    const doc = await extractFromText(CLEAN);
    const noMethod = { ...doc, extractionMethod: undefined } as unknown as ExtractedDocument;
    expect(shouldAutoPostReceipt(noMethod, AUTO_POST)).toBe(false);
    expect(refusesUnattendedApproval({ ...doc, extractionMethod: 'vlm+regex' })).toBe(true);
  });
});

describe('K-072 round 14 — credit, refund and return indicators', () => {
  const REFUNDS: Array<[string, string, number]> = [
    ['REFUND header', 'REFUND\nKettle 115.00\nVAT 15% 15.00\nTOTAL 115.00', 115],
    ['RETURN SLIP header', 'RETURN SLIP\nKettle 499.00\nTOTAL 499.00', 499],
    ['KREDIETNOTA header', 'Acme Voorrade\nKREDIETNOTA\nTotaal 115.00', 115],
    ['TERUGBETALING header', 'TERUGBETALING\nTotaal 115.00', 115],
    ['refund word on a figure line', 'Kettle 115.00\nTOTAL 115.00\nCARD REFUND 115.00', 115],
    ['trailing-minus total', 'Kettle 499.00-\nTOTAL 499.00-', 499],
    ['parenthesised total', 'Kettle (499.00)\nTOTAL (499.00)', 499],
  ];
  it.each(REFUNDS)('refuses a %s', (_name, text, total) => {
    expect(hasCreditIndicator(text, total)).toBe(true);
  });

  const PURCHASES: Array<[string, string, number]> = [
    ['credit-card surcharge item', 'Copy Paper 1000.00\nCredit card surcharge 15.00\nTotal 1015.00', 1015],
    ['VISA CREDIT tender', 'TOTAL 23.00\nVISA CREDIT 23.00', 23],
    ['NO REFUND WITHOUT SLIP footer', 'Total 299.00\nCARD 299.00\nNO REFUND WITHOUT SLIP', 299],
    ['refund-policy footer with no figure', 'Total 299.00\nRefunds within 30 days', 299],
    ['spaced-dash separator', 'Sub Total - 1000.00\nVAT - 150.00\nTotal Due - 1150.00', 1150],
    ['discount smaller than the total', 'Kettle 120.00\nPromo -30.00\nTOTAL 90.00', 90],
  ];
  it.each(PURCHASES)('does not refuse a %s', (_name, text, total) => {
    expect(hasCreditIndicator(text, total)).toBe(false);
  });

  it('isCreditNote refuses a negative total, whatever read it, on the VLM path too', () => {
    const vlm = { documentType: 'invoice' as const, rawText: '', totalAmount: -115 };
    expect(isCreditNote(vlm)).toBe(true);
    expect(isCreditNote({ ...vlm, totalAmount: 115 })).toBe(false);
  });
});

describe('K-072 round 14 — charges the round-13 rule explained away', () => {
  it('does not read `Chg` as change', () => {
    expect(unexplainedLargerFigure('Total 230.00\nPlease Pay 253.00 incl Svc Chg 23.00', 230)).toBe(253);
    // Even after a cash tender, `Chg` is a charge and nets nothing.
    expect(unexplainedLargerFigure('Total 230.00\nCASH 253.00\nDel Chg 23.00', 230)).toBe(253);
  });

  it('accepts change only after a CASH tender', () => {
    expect(unexplainedLargerFigure('Total 230.00\nCARD 253.00\nChange 23.00', 230)).toBe(253);
    expect(unexplainedLargerFigure('Total 230.00\nCASH 253.00\nChange 23.00', 230)).toBeNull();
  });

  it('reads a space-grouped payable followed by text as thousands', () => {
    expect(unexplainedLargerFigure('Total 1 150.00\nAMT DUE 1 265.00 ZAR', 1150)).toBe(1265);
    expect(unexplainedLargerFigure('Total 1 150.00\nAMT DUE R1 265.00 (incl)', 1150)).toBe(1265);
  });

  it('refuses a tip or charge added after the total, and a deduction taken after it', () => {
    expect(adjustmentAfterTotal('Total 230.00\nTip 23.00\nVISA 126.50\nMASTERCARD 126.50', 230)).toBe(23);
    expect(adjustmentAfterTotal('Total 230.00\nGratuity 23\nAMT DUE 253', 230)).toBe(23);
    expect(adjustmentAfterTotal('Total 253.00\nStaff Discount -23.00\nCARD 230.00', 253)).toBe(-23);
  });

  it('leaves a charge inside the total, a zero tip and a delivery-note number alone', () => {
    expect(adjustmentAfterTotal('Latte 38.00\nTip 5.00\nTotal 43.00\nCARD 43.00', 43)).toBeNull();
    expect(adjustmentAfterTotal('Total 230.00\nTip 0.00\nCARD 230.00', 230)).toBeNull();
    expect(adjustmentAfterTotal('Total 1150.00\nDelivery Note No: DN4471', 1150)).toBeNull();
  });
});
