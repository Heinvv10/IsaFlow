// src/modules/accounting/services/afs/cipcFilingGuideService.ts
// Generates a CIPC filing guide for an AFS document, including deadline,
// required forms, and a documents-ready checklist.
// Filing deadline is computed at runtime (fiscal year-end + 6 months).

import { sql, fmtDate } from '@/lib/neon';
import { log } from '@/lib/logger';
import { computePisScoreForDocument } from './pisCalculatorService';
import type { CipcFilingGuide } from './afsTypes';

// ── Internal helpers ──────────────────────────────────────────────────────────

function computeYearEnd(fiscalYear: number, financialYearStartMonth: number): string {
  let endMonth: number;
  const endYear: number = fiscalYear;
  if (financialYearStartMonth === 1) {
    endMonth = 12;
  } else {
    endMonth = financialYearStartMonth - 1;
  }
  const lastDay = new Date(endYear, endMonth, 0).getDate();
  return `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function computeFilingDeadline(yearEndIso: string): string {
  const yearEnd = new Date(yearEndIso);
  const deadline = new Date(yearEnd);
  deadline.setMonth(deadline.getMonth() + 6);
  return deadline.toISOString().split('T')[0] ?? '';
}

function buildRequiredFilings(
  requiredAudit: string,
  requiredCipcFiling: string
): string[] {
  if (requiredCipcFiling === 'fas_only') {
    return ['Financial Accountability Supplement (FAS)'];
  }
  if (requiredAudit === 'mandatory_audit') {
    return [
      'Annual Financial Statements (AFS)',
      "Auditor's Report",
      'XBRL/iXBRL filing',
    ];
  }
  // independent_review
  return [
    'Annual Financial Statements (AFS)',
    "Independent Reviewer's Report",
  ];
}

function determineNextStep(
  afsSignedOff: boolean,
  allMandatorySectionsReviewed: boolean,
  reviewerReportReady: boolean
): string {
  if (!afsSignedOff) {
    return 'Sign off the AFS document to complete the filing process';
  }
  if (!allMandatorySectionsReviewed) {
    return 'Ensure all mandatory sections are reviewed and approved';
  }
  if (!reviewerReportReady) {
    return 'Upload or confirm the reviewer/auditor report section';
  }
  return 'Submit the annual return and AFS to CIPC via the e-services portal';
}

// ── Internal DB row type ──────────────────────────────────────────────────────

interface DocumentRow {
  id: string;
  fiscal_year: number;
  status: string;
  pis_score: string | number | null;
  reporting_framework: string;
  name: string;
  registration_number: string | null;
  financial_year_start: number;
  cipc_annual_return_submitted: boolean;
  cipc_annual_return_submitted_at: string | Date | null;
}

interface SectionRow {
  section_type: string;
  status: string;
}

// ── Exported function ─────────────────────────────────────────────────────────

export async function generateCipcFilingGuide(
  companyId: string,
  documentId: string
): Promise<CipcFilingGuide> {
  log.info('cipcFilingGuideService: generating filing guide', { companyId, documentId });

  const [docRows, sectionRows, pisScore] = await Promise.all([
    sql`
      SELECT d.id, d.fiscal_year, d.status, d.pis_score, d.reporting_framework,
             c.name, c.registration_number, c.financial_year_start,
             c.cipc_annual_return_submitted, c.cipc_annual_return_submitted_at
      FROM afs_documents d
      JOIN companies c ON c.id = d.company_id
      WHERE d.id = ${documentId}::UUID
        AND d.company_id = ${companyId}::UUID
    ` as Promise<Record<string, unknown>[]>,
    sql`
      SELECT section_type, status
      FROM afs_sections
      WHERE document_id = ${documentId}::UUID
        AND company_id = ${companyId}::UUID
    ` as Promise<Record<string, unknown>[]>,
    computePisScoreForDocument(companyId, documentId),
  ]);

  if (docRows.length === 0) {
    throw new Error(`AFS document ${documentId} not found for company ${companyId}`);
  }

  const doc = docRows[0] as unknown as DocumentRow;
  const sections = sectionRows as unknown as SectionRow[];

  const fyStartMonth = (doc.financial_year_start as number) || 3;
  const yearEndIso = computeYearEnd(doc.fiscal_year, fyStartMonth);
  const filingDeadline = computeFilingDeadline(yearEndIso);

  const requiredFilings = buildRequiredFilings(pisScore.requiredAudit, pisScore.requiredCipcFiling);

  // ── Documents ready checklist ─────────────────────────────────────────────
  const afsSignedOff = doc.status === 'signed_off' || doc.status === 'filed';

  const mandatoryStatuses: string[] = ['reviewed', 'signed_off'];
  const allMandatorySectionsReviewed = sections.length > 0 && sections.every(
    s => mandatoryStatuses.includes(s.status)
  );

  const auditorSection = sections.find(s => s.section_type === 'auditors_report');
  const reviewerReportReady = auditorSection != null && auditorSection.status !== 'pending';

  const documentsReady: CipcFilingGuide['documentsReady'] = [
    {
      label: 'AFS signed off',
      ready: afsSignedOff,
      detail: afsSignedOff ? undefined : 'Mark AFS as signed off once reviewed and approved',
    },
    {
      label: 'All sections reviewed',
      ready: allMandatorySectionsReviewed,
      detail: allMandatorySectionsReviewed ? undefined : 'One or more sections are still pending or in progress',
    },
    {
      label: 'Reviewer/Auditor report uploaded',
      ready: reviewerReportReady,
      detail: reviewerReportReady ? undefined : 'Auditors report section is missing or still pending',
    },
    {
      label: 'CIPC annual return submitted',
      ready: doc.cipc_annual_return_submitted,
      detail: doc.cipc_annual_return_submitted
        ? `Submitted ${fmtDate(doc.cipc_annual_return_submitted_at)}`
        : 'Not yet submitted — mark it done once filed on the CIPC e-services portal',
    },
  ];

  const nextStep = determineNextStep(afsSignedOff, allMandatorySectionsReviewed, reviewerReportReady);

  log.info('cipcFilingGuideService: guide generated', { companyId, documentId, filingDeadline });

  return {
    companyName: doc.name,
    registrationNumber: doc.registration_number,
    yearEnd: yearEndIso,
    filingDeadline,
    pisScore: pisScore.total,
    requiredFilings,
    documentsReady,
    nextStep,
  };
}
