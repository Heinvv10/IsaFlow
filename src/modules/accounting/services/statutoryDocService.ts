/**
 * Statutory Document Service
 * Handles extraction from CIPC, tax clearance, B-BBEE, VAT certificates
 * and compliance alerting based on expiry dates.
 */


import { sql } from '@/lib/neon';
// import { extractStatutoryDocWithVlm, isVlmAvailable } from './vlmService';
import type {
  ExtractedStatutoryDoc,
  ComplianceAlert,
  StatutoryDocType,
} from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Document type mapping
// ---------------------------------------------------------------------------

const DOC_TYPE_MAP: Record<string, StatutoryDocType> = {
  cipc_certificate: 'cipc',
  tax_clearance: 'tax_clearance',
  bbbee_certificate: 'bbee',
  vat_registration: 'vat_registration',
};

const DOC_TYPE_LABELS: Record<StatutoryDocType, string> = {
  cipc: 'CIPC Registration Certificate',
  tax_clearance: 'Tax Clearance Certificate',
  bbee: 'B-BBEE Certificate',
  vat_registration: 'VAT Registration Certificate',
  unknown: 'Unknown Document',
};

// ---------------------------------------------------------------------------
// Compliance Alerts
// ---------------------------------------------------------------------------

/**
 * Check all statutory documents for a company and return compliance alerts.
 */
export async function checkComplianceAlerts(companyId: string): Promise<ComplianceAlert[]> {
  const alerts: ComplianceAlert[] = [];
  const now = new Date();

  const requiredTypes: StatutoryDocType[] = ['cipc', 'tax_clearance', 'bbee', 'vat_registration'];

  // Fetch all active statutory documents with extracted data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs = (await sql`
    SELECT document_type, document_name, extracted_data
    FROM company_documents
    WHERE company_id = ${companyId}::uuid AND is_active = true
    ORDER BY uploaded_at DESC
  `) as Array<Record<string, any>>;

  const docsByType = new Map<string, { name: string; extracted: ExtractedStatutoryDoc | null }>();

  for (const doc of docs) {
    const mappedType = DOC_TYPE_MAP[doc.document_type] || doc.document_type;
    if (!docsByType.has(mappedType)) {
      docsByType.set(mappedType, {
        name: doc.document_name,
        extracted: doc.extracted_data as ExtractedStatutoryDoc | null,
      });
    }
  }

  for (const reqType of requiredTypes) {
    const doc = docsByType.get(reqType);

    if (!doc) {
      alerts.push({
        documentType: reqType,
        documentName: DOC_TYPE_LABELS[reqType],
        status: 'missing',
        expiryDate: null,
        daysUntilExpiry: null,
        message: `${DOC_TYPE_LABELS[reqType]} has not been uploaded`,
      });
      continue;
    }

    const expiryDate = doc.extracted?.expiryDate;
    if (!expiryDate) {
      alerts.push({
        documentType: reqType,
        documentName: doc.name,
        status: 'valid',
        expiryDate: null,
        daysUntilExpiry: null,
        message: `${DOC_TYPE_LABELS[reqType]} uploaded (no expiry detected)`,
      });
      continue;
    }

    const expiry = new Date(expiryDate);
    const daysUntil = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    let status: ComplianceAlert['status'];
    let message: string;

    if (daysUntil < 0) {
      status = 'expired';
      message = `${DOC_TYPE_LABELS[reqType]} expired on ${expiryDate} (${Math.abs(daysUntil)} days ago)`;
    } else if (daysUntil <= 30) {
      status = 'expiring_soon';
      message = `${DOC_TYPE_LABELS[reqType]} expires in ${daysUntil} days (${expiryDate})`;
    } else if (daysUntil <= 90) {
      status = 'expiring_warning';
      message = `${DOC_TYPE_LABELS[reqType]} expires in ${daysUntil} days (${expiryDate})`;
    } else {
      status = 'valid';
      message = `${DOC_TYPE_LABELS[reqType]} valid until ${expiryDate} (${daysUntil} days)`;
    }

    alerts.push({
      documentType: reqType,
      documentName: doc.name,
      status,
      expiryDate,
      daysUntilExpiry: daysUntil,
      message,
    });
  }

  return alerts;
}
