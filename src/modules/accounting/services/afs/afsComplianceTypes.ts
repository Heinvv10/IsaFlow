// src/modules/accounting/services/afs/afsComplianceTypes.ts

// ── PIS ──────────────────────────────────────────────────────────────────────

export interface PisScore {
  turnoverPoints: number;       // GL revenue total / 1_000_000, rounded to 2 dp
  employeePoints: number;       // 0 (stubbed — no employee_count column yet)
  shareholderPoints: number;    // 0 (stubbed — no shareholder_count column yet)
  liabilityPoints: number;      // third-party liabilities / 1_000_000, rounded to 2 dp
  total: number;                // sum of all four
  requiredFramework: 'ifrs_smes' | 'full_ifrs';
  requiredAudit: 'voluntary' | 'independent_review' | 'mandatory_audit';
  requiredCipcFiling: 'fas_only' | 'afs_required';
  dataUnavailable: string[];    // e.g. ['employee_count', 'shareholder_count']
  calculatedAt: string;         // ISO timestamp
}

// ── Compliance checker ───────────────────────────────────────────────────────

export type CheckSeverity = 'blocker' | 'warning' | 'info';

export interface ComplianceIssue {
  checkId: string;              // e.g. 'structural.directors_report_missing'
  category: 'structural' | 'mathematical' | 'disclosure_quality';
  severity: CheckSeverity;
  message: string;
  sectionType?: string;         // SectionType from Plan 1 — which section to jump to
  detail?: string;              // optional extra context for the UI tooltip
}

export interface ComplianceResult {
  score: number;                // 0–100 integer
  passedCount: number;
  warningCount: number;
  blockerCount: number;
  issues: ComplianceIssue[];
  checkedAt: string;            // ISO timestamp
}

// ── CIPC Guide ───────────────────────────────────────────────────────────────

export interface CipcFilingGuide {
  companyName: string;
  registrationNumber: string | null;
  yearEnd: string;              // ISO date (YYYY-MM-DD)
  filingDeadline: string;       // yearEnd + 6 months (ISO date)
  pisScore: number;
  requiredFilings: string[];    // human-readable list
  documentsReady: Array<{
    label: string;
    ready: boolean;
    detail?: string;
  }>;
  nextStep: string;             // single most important action
}

// ── Compliance Alerts ────────────────────────────────────────────────────────

export type AfsAlertType =
  | 'pis_threshold_100'
  | 'pis_threshold_350'
  | 'afs_filing_deadline_30'
  | 'afs_filing_deadline_14'
  | 'afs_filing_deadline_7';
  // 'cipc_overdue' and 'bank_unreconciled_30d' removed — columns do not exist

export interface AfsComplianceAlert {
  id: string;
  companyId: string;
  alertType: AfsAlertType;
  message: string;
  detail?: string;
  firedAt: string;             // ISO timestamp
  dismissedAt: string | null;
  dismissedBy: string | null;
}
