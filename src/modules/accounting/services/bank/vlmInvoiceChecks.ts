/**
 * VLM invoice checks — the confidence score, document-type validation and
 * amount cross-checks applied to every parsed VLM invoice read.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { asNumber } from './vlmCore';

export function validateDocumentType(val: string | undefined): ExtractedDocument['documentType'] {
  const valid: ExtractedDocument['documentType'][] = [
    'invoice', 'credit_note', 'receipt', 'statement',
    'purchase_order', 'delivery_note', 'unknown',
  ];
  if (val && valid.includes(val as ExtractedDocument['documentType'])) {
    return val as ExtractedDocument['documentType'];
  }
  return 'unknown';
}

export function computeConfidence(parsed: Record<string, unknown>): number {
  const weights = {
    vendorName: 0.15, date: 0.15, referenceNumber: 0.10, totalAmount: 0.20,
    vatAmount: 0.10, lineItems: 0.10, documentType: 0.05, dueDate: 0.05,
    vendorVatNumber: 0.05, customerName: 0.05,
  };
  let score = 0;
  if (parsed.vendorName) score += weights.vendorName;
  if (parsed.date) score += weights.date;
  if (parsed.referenceNumber) score += weights.referenceNumber;
  if (asNumber(parsed.totalAmount) !== null && asNumber(parsed.totalAmount)! > 0) score += weights.totalAmount;
  if (asNumber(parsed.vatAmount) !== null) score += weights.vatAmount;
  if (Array.isArray(parsed.lineItems) && parsed.lineItems.length > 0) score += weights.lineItems;
  if (parsed.documentType && parsed.documentType !== 'unknown') score += weights.documentType;
  if (parsed.dueDate) score += weights.dueDate;
  if (parsed.vendorVatNumber) score += weights.vendorVatNumber;
  if (parsed.customerName) score += weights.customerName;
  return Math.round(score * 100) / 100;
}

export function validateAmounts(doc: ExtractedDocument): string[] {
  const warnings: string[] = [];
  if (doc.subtotal !== null && doc.vatAmount !== null && doc.totalAmount !== null) {
    const expected = Math.round((doc.subtotal + doc.vatAmount) * 100) / 100;
    if (Math.abs(expected - doc.totalAmount) > 0.02) {
      warnings.push(`Amount mismatch: subtotal (${doc.subtotal}) + VAT (${doc.vatAmount}) = ${expected}, but total is ${doc.totalAmount}`);
    }
  }
  if (doc.subtotal !== null && doc.vatRate !== null && doc.vatAmount !== null) {
    const expectedVat = Math.round(doc.subtotal * (doc.vatRate / 100) * 100) / 100;
    if (Math.abs(expectedVat - doc.vatAmount) > 1) {
      warnings.push(`VAT calculation may be incorrect: ${doc.vatRate}% of ${doc.subtotal} = ${expectedVat}, but extracted VAT is ${doc.vatAmount}`);
    }
  }
  if (doc.lineItems.length > 0 && doc.subtotal !== null) {
    const lineSum = Math.round(doc.lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0) * 100) / 100;
    if (lineSum > 0 && Math.abs(lineSum - doc.subtotal) > 1) {
      warnings.push(`Line items sum (${lineSum}) differs from subtotal (${doc.subtotal})`);
    }
  }
  return warnings;
}
