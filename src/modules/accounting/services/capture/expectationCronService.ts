/**
 * Expectation Cron Service — PRD-05 Phase 6
 *
 * Daily orchestrator that:
 *   1. Iterates every active company.
 *   2. Recomputes expectations from recent invoices.
 *   3. Detects gaps (creates pending alerts).
 *   4. For companies with chase_auto_send_enabled=true, auto-fires chase
 *      emails on alerts older than chase_grace_days, skipping suppliers that
 *      have chase_opted_out=true or no email on file.
 *
 * Failures on any one company are logged and swallowed — one tenant's bad
 * data must not halt the cron for everyone else.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recomputeAllForCompany } from './expectationEngineService';
import { detectGaps, sendEmailChase } from './missingInvoiceChaseService';
import { sendWhatsAppChase } from './whatsAppChaseService';

type Row = Record<string, unknown>;

export interface CompanyCronResult {
  companyId: string;
  recomputed: number;
  locked: number;
  gapsCreated: number;
  chasesSent: number;
  chasesSkipped: number;
  error?: string;
}

export interface CronRunResult {
  startedAt: string;
  finishedAt: string;
  companiesProcessed: number;
  totalGapsCreated: number;
  totalChasesSent: number;
  perCompany: CompanyCronResult[];
}

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function runDailyExpectationCron(): Promise<CronRunResult> {
  const startedAt = new Date().toISOString();
  const perCompany: CompanyCronResult[] = [];
  let totalGapsCreated = 0;
  let totalChasesSent = 0;

  const companyRows = (await sql`
    SELECT id, chase_auto_send_enabled, chase_grace_days, whatsapp_chase_enabled
    FROM companies
    WHERE is_active = TRUE OR is_active IS NULL
  `) as Row[];

  for (const company of companyRows) {
    const companyId = String(company.id);
    const autoSend = Boolean(company.chase_auto_send_enabled);
    const graceDays = Number(company.chase_grace_days ?? 3);
    const waChaseEnabled = Boolean(company.whatsapp_chase_enabled);

    const result: CompanyCronResult = {
      companyId,
      recomputed: 0,
      locked: 0,
      gapsCreated: 0,
      chasesSent: 0,
      chasesSkipped: 0,
    };

    try {
      const recomputeResult = await recomputeAllForCompany(companyId);
      result.recomputed = recomputeResult.processed;
      result.locked = recomputeResult.locked;

      const gaps = await detectGaps(companyId);
      result.gapsCreated = gaps.created;
      totalGapsCreated += gaps.created;

      if (autoSend) {
        const chaseResult = await autoChaseOverdue(companyId, graceDays, waChaseEnabled);
        result.chasesSent = chaseResult.sent;
        result.chasesSkipped = chaseResult.skipped;
        totalChasesSent += chaseResult.sent;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = msg;
      log.error('Cron: company processing failed', {
        companyId, error: msg,
      }, 'expectation-cron');
    }

    perCompany.push(result);
  }

  const finishedAt = new Date().toISOString();
  log.info('Cron: daily expectation run complete', {
    startedAt, finishedAt,
    companiesProcessed: perCompany.length,
    totalGapsCreated, totalChasesSent,
  }, 'expectation-cron');

  return {
    startedAt, finishedAt,
    companiesProcessed: perCompany.length,
    totalGapsCreated, totalChasesSent,
    perCompany,
  };
}

/**
 * Fires chases for pending alerts older than graceDays.
 * When whatsapp_chase_enabled is true AND the supplier has a whatsapp_number,
 * tries WhatsApp first; falls back to email on failure or missing number.
 * Suppliers without both email and WA number are skipped.
 */
async function autoChaseOverdue(
  companyId: string,
  graceDays: number,
  waChaseEnabled: boolean,
): Promise<{ sent: number; skipped: number }> {
  const alertRows = (await sql`
    SELECT a.id AS alert_id, s.whatsapp_number AS supplier_wa
    FROM expected_invoice_alerts a
    JOIN suppliers s ON s.id = a.supplier_id
    WHERE a.company_id = ${companyId}::uuid
      AND a.status = 'pending'
      AND a.expected_by <= (CURRENT_DATE - (${graceDays}::int || ' days')::interval)
      AND s.chase_opted_out = FALSE
      AND (s.email IS NOT NULL OR s.whatsapp_number IS NOT NULL)
  `) as Row[];

  let sent = 0;
  let skipped = 0;

  for (const row of alertRows) {
    const alertId = String(row.alert_id);
    const hasWa = Boolean(row.supplier_wa);

    try {
      let result: { sent: boolean; reason?: string } = { sent: false, reason: 'not attempted' };

      // Prefer WhatsApp when company opt-in and supplier has WA number
      if (waChaseEnabled && hasWa) {
        result = await sendWhatsAppChase(companyId, alertId, SYSTEM_USER_ID);
      }

      // Fall back to email when WA not enabled, no WA number, or WA send failed
      if (!result.sent) {
        result = await sendEmailChase(companyId, alertId, SYSTEM_USER_ID);
      }

      if (result.sent) sent += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      log.warn('Cron: chase failed for alert', {
        companyId, alertId,
        error: err instanceof Error ? err.message : String(err),
      }, 'expectation-cron');
    }
  }

  return { sent, skipped };
}
