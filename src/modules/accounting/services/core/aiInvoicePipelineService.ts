/**
 * AI Invoice Pipeline Service
 * Capture → Invoice → GL auto-pipeline.
 * Pure business logic — no database dependencies.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineThresholds {
  autoApproveConfidence: number;
  routeApprovalConfidence: number;
  highValueAmount: number;
  lowValueAutoApproveAmount: number;
}

export interface PipelineSupplierMatch {
  supplierId: string;
  supplierName: string;
  confidence: number;
}

export interface PipelineInvoiceInput {
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  paymentTerms?: string;
  reference?: string;
  totalAmount: number;
  taxAmount: number;
  taxRate: number;
  items: Array<{ description: string; quantity: number; unitPrice: number; taxRate: number }>;
  /** Set when the extraction read no VAT: the draft says so to the person approving it. */
  notes?: string;
}

/**
 * What a draft carries when the extraction read NO VAT (K-072 r30). The builder
 * used to invent 15/115 of the total as the invoice's tax, and the draft showed
 * that figure as if the document printed it — and an agent could approve it,
 * booking input VAT a non-VAT vendor never charged. Now the draft carries no
 * VAT at all and says why; the MCP approve tools refuse any VAT the captured
 * document does not show (`capturedVatEvidence`, r32), so an agent can approve
 * this draft only as it stands — claiming none.
 */
export const VAT_UNREAD_NOTE = 'VAT was not read from the captured document, so this draft carries NO VAT. '
  + 'If the document shows VAT, do not approve it as is: cancel it and enter the bill with its VAT.';

export interface PipelineValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type ApprovalRoute = 'auto_approve' | 'route_approval' | 'manual_review';

// ---------------------------------------------------------------------------
// Supplier suffix stripping (SA business names)
// ---------------------------------------------------------------------------

const STRIP_SUFFIXES = /\s*\(?(pty|ltd|limited|inc|cc|soc|npc|holdings|group|proprietary)\)?\s*/gi;

function normalize(name: string): string {
  return name.toLowerCase().replace(STRIP_SUFFIXES, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigA = new Set<string>();
  const bigB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigA.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigB.add(b.substring(i, i + 2));
  let inter = 0;
  for (const bg of bigA) if (bigB.has(bg)) inter++;
  return (2 * inter) / (bigA.size + bigB.size);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validatePipelineInput(extracted: ExtractedDocument): PipelineValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (extracted.totalAmount === null || extracted.totalAmount === undefined) errors.push('totalAmount is required');
  if (!extracted.vendorName) errors.push('vendorName is required');
  if (!extracted.date) errors.push('date is required');
  if (!extracted.referenceNumber) warnings.push('No reference/invoice number extracted');
  if (!extracted.lineItems || extracted.lineItems.length === 0) warnings.push('No line items extracted');

  return { valid: errors.length === 0, errors, warnings };
}

export function matchSupplierFromExtraction(
  extracted: ExtractedDocument,
  suppliers: Array<{ id: string; name: string }>,
): PipelineSupplierMatch | null {
  if (!extracted.vendorName) return null;
  if (suppliers.length === 0) return null;

  const normExtracted = normalize(extracted.vendorName);
  if (!normExtracted) return null;

  let best: PipelineSupplierMatch | null = null;

  for (const sup of suppliers) {
    const normSup = normalize(sup.name);
    if (!normSup) continue;

    // Exact match
    if (normExtracted === normSup) {
      return { supplierId: sup.id, supplierName: sup.name, confidence: 1.0 };
    }

    // Containment
    if (normExtracted.includes(normSup) || normSup.includes(normExtracted)) {
      const score = 0.7 + (Math.min(normExtracted.length, normSup.length) / Math.max(normExtracted.length, normSup.length)) * 0.3;
      if (!best || score > best.confidence) {
        best = { supplierId: sup.id, supplierName: sup.name, confidence: Math.round(score * 100) / 100 };
      }
      continue;
    }

    // Dice coefficient
    const score = diceCoefficient(normExtracted, normSup);
    if (score >= 0.6 && (!best || score > best.confidence)) {
      best = { supplierId: sup.id, supplierName: sup.name, confidence: Math.round(score * 100) / 100 };
    }
  }

  return best;
}

export function buildInvoiceFromExtraction(
  extracted: ExtractedDocument,
  supplierId: string,
): PipelineInvoiceInput {
  // A VAT the document never showed is never invented (K-072 r30): no VAT read
  // is no VAT on the draft, at a 0% rate, flagged for the person approving it.
  const vatRead = extracted.vatAmount !== null && extracted.vatAmount !== undefined;
  const taxRate = vatRead ? (extracted.vatRate ?? 15) : 0;

  return {
    supplierId,
    invoiceNumber: extracted.referenceNumber || `VLM-${Date.now()}`,
    invoiceDate: extracted.date || new Date().toISOString().split('T')[0]!,
    dueDate: extracted.dueDate || undefined,
    paymentTerms: extracted.paymentTerms || undefined,
    reference: extracted.purchaseOrderRef || undefined,
    totalAmount: extracted.totalAmount ?? 0,
    taxAmount: vatRead ? extracted.vatAmount! : 0,
    taxRate,
    notes: vatRead ? undefined : VAT_UNREAD_NOTE,
    items: extracted.lineItems.length > 0
      ? extracted.lineItems.map(li => ({
          description: li.description,
          quantity: li.quantity ?? 1,
          unitPrice: li.unitPrice ?? li.total ?? 0,
          taxRate,
        }))
      : [{ description: 'As per invoice', quantity: 1, unitPrice: (vatRead ? extracted.subtotal : null) ?? extracted.totalAmount ?? 0, taxRate }],
  };
}

export function determineApprovalRoute(
  confidence: number,
  totalAmount: number,
  thresholds: PipelineThresholds,
): ApprovalRoute {
  // High-value items always need manual review
  if (totalAmount > thresholds.highValueAmount) return 'manual_review';

  // Low-value items can be auto-approved with lower confidence
  if (totalAmount <= thresholds.lowValueAutoApproveAmount && confidence >= thresholds.routeApprovalConfidence) {
    return 'auto_approve';
  }

  if (confidence >= thresholds.autoApproveConfidence) return 'auto_approve';
  if (confidence >= thresholds.routeApprovalConfidence) return 'route_approval';
  return 'manual_review';
}

export function computePipelineConfidence(
  extracted: ExtractedDocument,
  supplierMatch: PipelineSupplierMatch | null,
): number {
  if (!supplierMatch) return 0;

  const extractionConfidence = extracted.confidence;
  const matchConfidence = supplierMatch.confidence;
  const warningPenalty = extracted.warnings.length * 0.02;

  const combined = (extractionConfidence * 0.6 + matchConfidence * 0.4) - warningPenalty;
  return Math.max(0, Math.min(1, Math.round(combined * 100) / 100));
}
