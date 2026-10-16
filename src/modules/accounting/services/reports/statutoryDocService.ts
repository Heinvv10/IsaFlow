/**
 * Statutory Document Service
 * Handles extraction from CIPC, tax clearance, B-BBEE, VAT certificates
 * and compliance alerting based on expiry dates.
 */


import { sql } from '@/lib/neon';
import { getEntityType, isEntityTypeCode, DEFAULT_ENTITY_TYPE } from '@/lib/entityTypes';
// import { extractStatutoryDocWithVlm, isVlmAvailable } from '../bank/vlmService';
import type {
  ExtractedStatutoryDoc,
  ComplianceAlert,
  StatutoryDocType,
} from '@/modules/accounting/types/documentCapture.types';

type CompanyDocumentRow = {
  document_type: string;
  document_name: string;
  extracted_data: ExtractedStatutoryDoc | null;
};

// ---------------------------------------------------------------------------
// Document type mapping
// ---------------------------------------------------------------------------

const DOC_TYPE_MAP: Record<string, StatutoryDocType> = {
  cipc_certificate: 'cipc',
  ck_certificate: 'ck_certificate',
  letters_of_authority: 'letters_of_authority',
  tax_clearance: 'tax_clearance',
  bbbee_certificate: 'bbee',
  vat_registration: 'vat_registration',
};

const DOC_TYPE_LABELS: Record<StatutoryDocType, string> = {
  cipc: 'CIPC Registration Certificate',
  ck_certificate: 'CK1 / CK2 Founding Statement',
  letters_of_authority: "Master's Letters of Authority",
  tax_clearance: 'Tax Clearance Certificate',
  bbee: 'B-BBEE Certificate',
  vat_registration: 'VAT Registration Certificate',
  unknown: 'Unknown Document',
};

/**
 * The registration document this company must hold: its entity type's required
 * proof when that is a company document (CIPC certificate, CK1/CK2, Letters of
 * Authority). None for a sole proprietor, partnership or "other", whose proof
 * is people's IDs or nothing; they get no "CIPC missing" alert.
 */
async function registrationProofTypes(companyId: string): Promise<StatutoryDocType[]> {
  const rows = (await sql`SELECT entity_type FROM companies WHERE id = ${companyId}::uuid`) as { entity_type: string | null }[];
  const stored = rows[0]?.entity_type;
  const proof = getEntityType(isEntityTypeCode(stored) ? stored : DEFAULT_ENTITY_TYPE).requiredProof;
  if (proof.kind !== 'document') return [];
  const mapped = DOC_TYPE_MAP[proof.documentType];
  return mapped ? [mapped] : [];
}

// ---------------------------------------------------------------------------
// Compliance Alerts
// ---------------------------------------------------------------------------

/**
 * Check all statutory documents for a company and return compliance alerts.
 */
export async function checkComplianceAlerts(companyId: string): Promise<ComplianceAlert[]> {
  const alerts: ComplianceAlert[] = [];
  const now = new Date();

  const requiredTypes: StatutoryDocType[] = [
    ...await registrationProofTypes(companyId), 'tax_clearance', 'bbee', 'vat_registration',
  ];

  // Fetch all active statutory documents with extracted data
   
  const docs = (await sql<CompanyDocumentRow>`
    SELECT document_type, document_name, extracted_data
    FROM company_documents
    WHERE company_id = ${companyId}::uuid AND is_active = true
    ORDER BY uploaded_at DESC
  `);

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
