/**
 * Document Validation Service
 * Compares VLM-extracted data against entity records to detect discrepancies.
 */

import type {
  ExtractedDocument,
  ExtractedStatutoryDoc,
  ValidationDiscrepancy,
  DocumentValidationResult,
} from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Invoice Validation
// ---------------------------------------------------------------------------

interface InvoiceRecord {
  invoiceNumber?: string;
  totalAmount?: number;
  vatAmount?: number;
  taxRate?: number;
  vendorName?: string;
  supplierName?: string;
  customerName?: string;
  clientName?: string;
  invoiceDate?: string;
}

export function validateInvoiceDocument(
  extracted: ExtractedDocument,
  invoice: InvoiceRecord,
): DocumentValidationResult {
  const discrepancies: ValidationDiscrepancy[] = [];

  // Total amount
  if (extracted.totalAmount !== null && invoice.totalAmount !== undefined) {
    const diff = Math.abs(extracted.totalAmount - invoice.totalAmount);
    if (diff > 0.02) {
      discrepancies.push({
        field: 'totalAmount',
        expected: invoice.totalAmount,
        actual: extracted.totalAmount,
        severity: diff > invoice.totalAmount * 0.05 ? 'error' : 'warning',
        message: `Total mismatch: document shows ${extracted.totalAmount}, record has ${invoice.totalAmount}`,
      });
    }
  }

  // VAT amount
  if (extracted.vatAmount !== null && invoice.vatAmount !== undefined) {
    const diff = Math.abs(extracted.vatAmount - invoice.vatAmount);
    if (diff > 1) {
      discrepancies.push({
        field: 'vatAmount',
        expected: invoice.vatAmount,
        actual: extracted.vatAmount,
        severity: 'warning',
        message: `VAT mismatch: document shows ${extracted.vatAmount}, record has ${invoice.vatAmount}`,
      });
    }
  }

  // VAT arithmetic check
  if (extracted.subtotal !== null && extracted.vatAmount !== null && extracted.totalAmount !== null) {
    const expected = Math.round((extracted.subtotal + extracted.vatAmount) * 100) / 100;
    if (Math.abs(expected - extracted.totalAmount) > 0.02) {
      discrepancies.push({
        field: 'vatArithmetic',
        expected: expected,
        actual: extracted.totalAmount,
        severity: 'error',
        message: `VAT arithmetic error on document: subtotal (${extracted.subtotal}) + VAT (${extracted.vatAmount}) = ${expected}, but total shows ${extracted.totalAmount}`,
      });
    }
  }

  // Reference number
  if (extracted.referenceNumber && invoice.invoiceNumber) {
    const normExtracted = extracted.referenceNumber.replace(/[-\s/]/g, '').toLowerCase();
    const normInvoice = invoice.invoiceNumber.replace(/[-\s/]/g, '').toLowerCase();
    if (normExtracted !== normInvoice) {
      discrepancies.push({
        field: 'referenceNumber',
        expected: invoice.invoiceNumber,
        actual: extracted.referenceNumber,
        severity: 'warning',
        message: `Reference mismatch: document shows "${extracted.referenceNumber}", record has "${invoice.invoiceNumber}"`,
      });
    }
  }

  // Vendor/customer name (fuzzy check)
  const entityName = invoice.vendorName || invoice.supplierName || invoice.customerName || invoice.clientName;
  const extractedName = extracted.vendorName || extracted.customerName;
  if (entityName && extractedName) {
    const normEntity = entityName.toLowerCase().replace(/\b(pty|ltd|cc|inc)\b/gi, '').trim();
    const normExtracted = extractedName.toLowerCase().replace(/\b(pty|ltd|cc|inc)\b/gi, '').trim();
    if (!normExtracted.includes(normEntity) && !normEntity.includes(normExtracted)) {
      discrepancies.push({
        field: 'entityName',
        expected: entityName,
        actual: extractedName,
        severity: 'warning',
        message: `Name mismatch: document shows "${extractedName}", record has "${entityName}"`,
      });
    }
  }

  // Date check
  if (extracted.date && invoice.invoiceDate) {
    if (extracted.date !== invoice.invoiceDate) {
      discrepancies.push({
        field: 'date',
        expected: invoice.invoiceDate,
        actual: extracted.date,
        severity: 'info',
        message: `Date differs: document shows ${extracted.date}, record has ${invoice.invoiceDate}`,
      });
    }
  }

  const errorCount = discrepancies.filter(d => d.severity === 'error').length;
  const warningCount = discrepancies.filter(d => d.severity === 'warning').length;
  const score = Math.max(0, 1 - (errorCount * 0.3 + warningCount * 0.1));

  return {
    valid: errorCount === 0,
    score: Math.round(score * 100) / 100,
    discrepancies,
    validatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Payment Receipt Validation
// ---------------------------------------------------------------------------

interface PaymentRecord {
  totalAmount?: number;
  paymentDate?: string;
  reference?: string;
  bankReference?: string;
}

export function validatePaymentReceipt(
  extracted: ExtractedDocument,
  payment: PaymentRecord,
): DocumentValidationResult {
  const discrepancies: ValidationDiscrepancy[] = [];

  if (extracted.totalAmount !== null && payment.totalAmount !== undefined) {
    const diff = Math.abs(extracted.totalAmount - payment.totalAmount);
    if (diff > 0.02) {
      discrepancies.push({
        field: 'totalAmount',
        expected: payment.totalAmount,
        actual: extracted.totalAmount,
        severity: diff > payment.totalAmount * 0.01 ? 'error' : 'warning',
        message: `Amount mismatch: receipt shows ${extracted.totalAmount}, payment record has ${payment.totalAmount}`,
      });
    }
  }

  if (extracted.date && payment.paymentDate) {
    const docDate = new Date(extracted.date);
    const payDate = new Date(payment.paymentDate);
    const daysDiff = Math.abs((docDate.getTime() - payDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff > 7) {
      discrepancies.push({
        field: 'date',
        expected: payment.paymentDate,
        actual: extracted.date,
        severity: 'warning',
        message: `Date differs by ${Math.round(daysDiff)} days: receipt ${extracted.date}, payment ${payment.paymentDate}`,
      });
    }
  }

  const errorCount = discrepancies.filter(d => d.severity === 'error').length;
  const score = Math.max(0, 1 - (errorCount * 0.3 + (discrepancies.length - errorCount) * 0.1));

  return {
    valid: errorCount === 0,
    score: Math.round(score * 100) / 100,
    discrepancies,
    validatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Statutory Compliance Validation
// ---------------------------------------------------------------------------

interface CompanyRecord {
  companyName?: string;
  registrationNumber?: string;
  vatNumber?: string;
}

export function validateStatutoryCompliance(
  extracted: ExtractedStatutoryDoc,
  company: CompanyRecord,
): DocumentValidationResult {
  const discrepancies: ValidationDiscrepancy[] = [];

  if (extracted.entityName && company.companyName) {
    const normExtracted = extracted.entityName.toLowerCase().replace(/\b(pty|ltd|cc|inc)\b/gi, '').trim();
    const normCompany = company.companyName.toLowerCase().replace(/\b(pty|ltd|cc|inc)\b/gi, '').trim();
    if (!normExtracted.includes(normCompany) && !normCompany.includes(normExtracted)) {
      discrepancies.push({
        field: 'entityName',
        expected: company.companyName,
        actual: extracted.entityName,
        severity: 'error',
        message: `Entity name mismatch: certificate shows "${extracted.entityName}", company is "${company.companyName}"`,
      });
    }
  }

  if (extracted.expiryDate) {
    const expiry = new Date(extracted.expiryDate);
    const now = new Date();
    if (expiry < now) {
      discrepancies.push({
        field: 'expiryDate',
        expected: 'valid (not expired)',
        actual: extracted.expiryDate,
        severity: 'error',
        message: `Certificate expired on ${extracted.expiryDate}`,
      });
    } else {
      const daysUntil = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (daysUntil < 30) {
        discrepancies.push({
          field: 'expiryDate',
          expected: 'valid for >30 days',
          actual: `${daysUntil} days remaining`,
          severity: 'warning',
          message: `Certificate expires in ${daysUntil} days (${extracted.expiryDate})`,
        });
      }
    }
  }

  if (extracted.vatNumber && company.vatNumber && extracted.vatNumber !== company.vatNumber) {
    discrepancies.push({
      field: 'vatNumber',
      expected: company.vatNumber,
      actual: extracted.vatNumber,
      severity: 'error',
      message: `VAT number mismatch: certificate shows ${extracted.vatNumber}, company has ${company.vatNumber}`,
    });
  }

  const errorCount = discrepancies.filter(d => d.severity === 'error').length;
  const score = Math.max(0, 1 - (errorCount * 0.3 + (discrepancies.length - errorCount) * 0.1));

  return {
    valid: errorCount === 0,
    score: Math.round(score * 100) / 100,
    discrepancies,
    validatedAt: new Date().toISOString(),
  };
}
