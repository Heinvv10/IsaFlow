// src/modules/accounting/services/afs/complianceAlertService.ts
// AFS-specific compliance alert service.
// Handles PIS threshold crossings and filing deadline alerts.
// CIPC overdue and bank unreconciled detectors are stubs (columns do not exist).
// Idempotent inserts via partial unique index on (company_id, alert_type) WHERE dismissed_at IS NULL.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AfsComplianceAlert, AfsAlertType } from './afsTypes';

// ── Internal helpers ──────────────────────────────────────────────────────────

function computeFiscalYearEnd(fiscalYear: number, financialYearStartMonth: number): Date {
  let endMonth: number;
  let endYear: number;
  if (financialYearStartMonth === 1) {
    endMonth = 12;
    endYear = fiscalYear;
  } else {
    endMonth = financialYearStartMonth - 1;
    endYear = fiscalYear;
  }
  const lastDay = new Date(endYear, endMonth, 0).getDate();
  return new Date(endYear, endMonth - 1, lastDay);
}

async function fireAlert(
  companyId: string,
  alertType: AfsAlertType,
  message: string,
  detail?: string
): Promise<void> {
  await (sql`
    INSERT INTO compliance_alerts (company_id, alert_type, message, detail)
    VALUES (${companyId}::UUID, ${alertType}, ${message}, ${detail ?? null})
    ON CONFLICT (company_id, alert_type) WHERE dismissed_at IS NULL
    DO NOTHING
  ` as Promise<unknown>);
}

// ── Exported: create / dismiss / fetch ────────────────────────────────────────

/**
 * Create a compliance alert for a company. Idempotent via partial unique index.
 */
export async function createAfsAlert(
  companyId: string,
  alertType: AfsAlertType,
  message: string,
  severity: string,
  detail?: string
): Promise<void> {
  log.info('complianceAlertService: creating alert', { companyId, alertType, severity });
  await fireAlert(companyId, alertType, message, detail);
}

/**
 * Fetch all un-dismissed AFS compliance alerts for a company.
 */
export async function getActiveAfsAlerts(companyId: string): Promise<AfsComplianceAlert[]> {
  const rows = (await sql`
    SELECT id, company_id, alert_type, message, detail,
           fired_at, dismissed_at, dismissed_by
    FROM compliance_alerts
    WHERE company_id = ${companyId}::UUID
      AND dismissed_at IS NULL
    ORDER BY fired_at DESC
  `) as Record<string, unknown>[];

  return rows.map(r => ({
    id: r.id as string,
    companyId: r.company_id as string,
    alertType: r.alert_type as AfsAlertType,
    message: r.message as string,
    detail: r.detail != null ? (r.detail as string) : undefined,
    firedAt: r.fired_at instanceof Date
      ? r.fired_at.toISOString()
      : (r.fired_at as string),
    dismissedAt: null,
    dismissedBy: null,
  }));
}

/**
 * Dismiss an alert. Tenant-scoped update.
 */
export async function dismissAfsAlert(
  companyId: string,
  alertId: string,
  userId: string
): Promise<void> {
  log.info('complianceAlertService: dismissing alert', { companyId, alertId });
  await (sql`
    UPDATE compliance_alerts
    SET dismissed_at = now(), dismissed_by = ${userId}
    WHERE id = ${alertId}::UUID
      AND company_id = ${companyId}::UUID
  ` as Promise<unknown>);
}

// ── Detector: PIS threshold crossings ────────────────────────────────────────

async function detectPisThresholdAlerts(companyId: string): Promise<void> {
  const rows = (await sql`
    SELECT id, pis_score
    FROM afs_documents
    WHERE company_id = ${companyId}::UUID
      AND pis_score IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 2
  `) as Record<string, unknown>[];

  if (rows.length < 2) {
    log.debug('complianceAlertService: not enough documents for PIS threshold comparison', { companyId });
    return;
  }

  // rows.length >= 2 is guaranteed above; non-null assertion is safe
   
  const current = Number(rows[0]!.pis_score);
   
  const prior = Number(rows[1]!.pis_score);

  if (current >= 100 && prior < 100) {
    await fireAlert(
      companyId,
      'pis_threshold_100',
      'Your Public Interest Score has crossed 100 — independent review is now required',
      `Previous PIS: ${prior}, Current PIS: ${current}`
    );
  }

  if (current >= 350 && prior < 350) {
    await fireAlert(
      companyId,
      'pis_threshold_350',
      'Your Public Interest Score has crossed 350 — full IFRS and mandatory audit are now required',
      `Previous PIS: ${prior}, Current PIS: ${current}`
    );
  }
}

// ── Detector: Filing deadline approaching ────────────────────────────────────

async function detectFilingDeadlineAlerts(companyId: string): Promise<void> {
  const rows = (await sql`
    SELECT d.id, d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.company_id = ${companyId}::UUID
      AND d.status NOT IN ('signed_off', 'filed')
      AND d.document_type = 'afs'
  `) as Record<string, unknown>[];

  const now = Date.now();

  for (const row of rows) {
    const fiscalYear = row.fiscal_year as number;
    const fyStartMonth = (row.financial_year_start as number) || 3;

    const yearEnd = computeFiscalYearEnd(fiscalYear, fyStartMonth);
    const deadline = new Date(yearEnd);
    deadline.setMonth(deadline.getMonth() + 6);

    const daysUntil = Math.ceil((deadline.getTime() - now) / (1000 * 60 * 60 * 24));

    if (daysUntil <= 7) {
      await fireAlert(
        companyId,
        'afs_filing_deadline_7',
        `AFS filing deadline is in ${daysUntil} day(s)`,
        `Deadline: ${deadline.toISOString().split('T')[0]}`
      );
    } else if (daysUntil <= 14) {
      await fireAlert(
        companyId,
        'afs_filing_deadline_14',
        `AFS filing deadline is in ${daysUntil} day(s)`,
        `Deadline: ${deadline.toISOString().split('T')[0]}`
      );
    } else if (daysUntil <= 30) {
      await fireAlert(
        companyId,
        'afs_filing_deadline_30',
        `AFS filing deadline is approaching — ${daysUntil} day(s) remaining`,
        `Deadline: ${deadline.toISOString().split('T')[0]}`
      );
    }
  }
}

// ── Detector stubs ────────────────────────────────────────────────────────────

function detectCipcOverdueAlerts(companyId: string): void {
  // STUB: companies.cipc_annual_return_due does not exist.
  // Activate when column is added.
  log.debug('complianceAlertService: CIPC overdue detector skipped — column not available', { companyId });
}

function detectBankUnreconciledAlerts(companyId: string): void {
  // STUB: bank_accounts.last_reconciled_at does not exist.
  // Future: query bank_reconciliations table for most recent reconciliation per account.
  log.debug('complianceAlertService: bank unreconciled detector skipped — column not available', { companyId });
}

// ── Exported: detect and fire all alerts ─────────────────────────────────────

/**
 * Run all active detectors for a company.
 * Idempotent — safe to call repeatedly (ON CONFLICT DO NOTHING).
 */
export async function detectAndFireAfsAlerts(companyId: string): Promise<void> {
  log.info('complianceAlertService: running detectors', { companyId });

  detectCipcOverdueAlerts(companyId);
  detectBankUnreconciledAlerts(companyId);

  await Promise.all([
    detectPisThresholdAlerts(companyId),
    detectFilingDeadlineAlerts(companyId),
  ]);

  log.info('complianceAlertService: detectors complete', { companyId });
}
