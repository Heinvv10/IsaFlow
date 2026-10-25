// src/modules/accounting/services/afs/reportTemplateShared.ts
// The context the report wording templates read, and the wording helpers they share.
// Templates: reportTemplates.ts (directors' reports, general information) and
// practitionerReports.ts (compilation, accounting officer, review, audit).

import type { AfsTemplateKey } from '@/lib/entityTypes';
import { periodPhrase } from './afsReportingPeriod';

// ── Template Data Context ────────────────────────────────────────────────────

export interface ReportTemplateContext {
  companyName: string;
  registrationNumber: string | null;
  /** e.g. "28 February 2026" */
  periodEnd: string;
  /** e.g. "1 March 2025" */
  periodStart: string;
  /** Whole months the statements cover; 12 when absent. A transition year is "14 months ended X". */
  periodMonths?: number;
  framework: 'ifrs_smes' | 'full_ifrs';
  /** Pty = Private Company, CC = Close Corporation, Trust */
  entityType: AfsTemplateKey;
  /** Name of the accounting firm / practitioner */
  practitionerName?: string;
  /** City where the report is signed */
  practitionerCity?: string;
  /** Date the report is signed (ISO string) */
  reportDate?: string;
  /** Directors' names for the directors' report */
  directorNames?: string[];
  /** Registered address */
  registeredAddress?: string;
  /** Nature of business */
  natureOfBusiness?: string;
}

// ── Entity-type labels ───────────────────────────────────────────────────────

export function entityLabel(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'close corporation';
    case 'trust': return 'trust';
    default: return 'company';
  }
}

export function entityLeadership(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'members';
    case 'trust': return 'trustees';
    default: return 'directors';
  }
}

export function entityLeadershipSingular(entityType: ReportTemplateContext['entityType']): string {
  switch (entityType) {
    case 'cc': return 'member';
    case 'trust': return 'trustee';
    default: return 'director';
  }
}

/** "year ended X" for twelve months, "14 months ended X" otherwise. */
export function endedPhrase(ctx: ReportTemplateContext): string {
  return periodPhrase(ctx.periodMonths ?? 12, ctx.periodEnd);
}

/** "year" for twelve months, else "period": "for the year then ended" / "for the period then ended". */
export function thenNoun(ctx: ReportTemplateContext): string {
  return (ctx.periodMonths ?? 12) === 12 ? 'year' : 'period';
}

export function frameworkLabel(framework: ReportTemplateContext['framework']): string {
  return framework === 'full_ifrs'
    ? 'International Financial Reporting Standards'
    : 'International Financial Reporting Standard for Small and Medium-sized Entities';
}

export function frameworkShort(framework: ReportTemplateContext['framework']): string {
  return framework === 'full_ifrs' ? 'IFRS' : 'IFRS for SMEs';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
