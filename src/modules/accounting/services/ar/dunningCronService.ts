/**
 * PRD-06 Phase 5 — Dunning cron walker.
 *
 * Runs once a day (weekday morning). For every company with auto_send_enabled,
 * walks that company's open overdue customer_invoices through the dunning
 * ladder and sends the appropriate template. Multiple safety gates prevent
 * duplicate / premature / offensive sends.
 *
 * Gates (any one fails → skip):
 *   - company dunning_settings.auto_send_enabled = true
 *   - today is a weekday (global) — template.send_weekdays_only enforced per row
 *   - invoice is not cancelled and not fully paid
 *   - invoice outstanding ≥ company min_outstanding_zar
 *   - invoice days_overdue matches a template's range (active, highest escalation_order)
 *   - invoice has NO open customer_invoice_dispute
 *   - NO existing dunning_send for (invoice, template) — never re-send same tone
 *   - NO dunning_send for invoice in last 48h — cool-off
 *   - customer has email on file
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendDunning } from './dunningService';

export interface DunningCronResult {
  companiesChecked: number;
  invoicesConsidered: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface CompanyRow extends DbRow {
  company_id: string;
  min_outstanding_zar: string | number;
}

interface CandidateRow extends DbRow {
  invoice_id: string;
  invoice_number: string;
  company_id: string;
  outstanding: string | number;
  days_overdue: number;
  customer_email: string | null;
  has_open_dispute: boolean;
  template_id: string | null;
  template_send_weekdays_only: boolean | null;
  last_send_for_template_at: string | null;
  last_send_any_at: string | null;
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const SATURDAY = 6;
const SUNDAY = 0;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === SATURDAY || day === SUNDAY;
}

/**
 * Runs one pass of the dunning ladder across all opted-in companies.
 * Returns a summary for logging/telemetry. Never throws: per-invoice errors
 * are collected and surfaced in `errors`.
 */
export async function runDunningCron(options: {
  portalBaseUrl?: string;
  /** Override for "now" — test-only. */
  now?: Date;
} = {}): Promise<DunningCronResult> {
  const now = options.now ?? new Date();
  const result: DunningCronResult = {
    companiesChecked: 0,
    invoicesConsidered: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  if (isWeekend(now)) {
    log.info('Dunning cron skipped — weekend', { now: now.toISOString() }, 'dunningCron');
    return result;
  }

  const companies = (await sql`
    SELECT company_id, min_outstanding_zar
    FROM dunning_settings
    WHERE auto_send_enabled = true
  `) as CompanyRow[];
  result.companiesChecked = companies.length;

  for (const c of companies) {
    const companyId = String(c.company_id);
    const minOutstanding = Number(c.min_outstanding_zar ?? 0);

    const candidates = (await sql`
      WITH overdue_invoices AS (
        SELECT ci.id AS invoice_id,
               ci.invoice_number,
               ci.company_id,
               cust.id AS customer_id,
               (ci.total_amount - COALESCE(ci.amount_paid, 0)) AS outstanding,
               GREATEST(0, (CURRENT_DATE - ci.due_date))::int AS days_overdue,
               cust.email AS customer_email
          FROM customer_invoices ci
          JOIN customers cust
            ON cust.id = COALESCE(ci.client_id, ci.customer_id)
           AND cust.company_id = ci.company_id
          LEFT JOIN customer_dunning_overrides cdo
            ON cdo.company_id = ci.company_id AND cdo.customer_id = cust.id
         WHERE ci.company_id = ${companyId}::uuid
           AND ci.status NOT IN ('cancelled', 'paid')
           AND ci.due_date IS NOT NULL
           AND ci.due_date < CURRENT_DATE
           AND (ci.total_amount - COALESCE(ci.amount_paid, 0)) >= ${minOutstanding}
           AND COALESCE(cdo.suppress_dunning, false) = false
      ),
      matched AS (
        SELECT oi.*,
               COALESCE(ovr.id, dt.id) AS template_id,
               COALESCE(ovr.send_weekdays_only, dt.send_weekdays_only)
                 AS template_send_weekdays_only,
               COALESCE(ovr.escalation_order, dt.escalation_order) AS escalation_order
          FROM overdue_invoices oi
          LEFT JOIN LATERAL (
              SELECT ovr.id, ovr.send_weekdays_only, ovr.escalation_order
                FROM customer_dunning_overrides cdo
                JOIN dunning_templates ovr
                  ON ovr.id = cdo.template_id_override AND ovr.active = true
               WHERE cdo.company_id = oi.company_id
                 AND cdo.customer_id = oi.customer_id
                 AND cdo.template_id_override IS NOT NULL
               LIMIT 1
          ) ovr ON true
          LEFT JOIN LATERAL (
              SELECT dt.id, dt.send_weekdays_only, dt.escalation_order
                FROM dunning_templates dt
               WHERE dt.company_id = oi.company_id
                 AND dt.active = true
                 AND oi.days_overdue >= dt.days_overdue_min
                 AND (dt.days_overdue_max IS NULL OR oi.days_overdue <= dt.days_overdue_max)
               ORDER BY dt.escalation_order DESC
               LIMIT 1
          ) dt ON ovr.id IS NULL
      )
      SELECT m.invoice_id, m.invoice_number, m.company_id, m.outstanding,
             m.days_overdue, m.customer_email,
             m.template_id, m.template_send_weekdays_only,
             EXISTS (
               SELECT 1 FROM customer_invoice_disputes d
                WHERE d.customer_invoice_id = m.invoice_id
                  AND d.status = 'open'
             ) AS has_open_dispute,
             (SELECT MAX(sent_at) FROM dunning_sends
               WHERE customer_invoice_id = m.invoice_id AND template_id = m.template_id)
               AS last_send_for_template_at,
             (SELECT MAX(sent_at) FROM dunning_sends
               WHERE customer_invoice_id = m.invoice_id)
               AS last_send_any_at
      FROM matched m
    `) as CandidateRow[];

    for (const row of candidates) {
      result.invoicesConsidered += 1;
      const invoiceId = String(row.invoice_id);
      try {
        if (!row.template_id) { result.skipped += 1; continue; }
        if (!row.customer_email) { result.skipped += 1; continue; }
        if (row.has_open_dispute) { result.skipped += 1; continue; }
        if (row.last_send_for_template_at) { result.skipped += 1; continue; }
        if (row.last_send_any_at) {
          const last = new Date(row.last_send_any_at).getTime();
          if (now.getTime() - last < TWO_DAYS_MS) { result.skipped += 1; continue; }
        }
        if (row.template_send_weekdays_only && isWeekend(now)) {
          result.skipped += 1;
          continue;
        }

        // One savepoint per invoice. sendDunning writes (portal_token,
        // dunning_sends, captured_documents), and a PostgreSQL error on any of
        // them aborts the whole surrounding transaction — the catch below would
        // otherwise carry on into a run where every remaining invoice fails with
        // 25P02. Rolling back to the savepoint restores a usable transaction.
        const sendResult = await withSavepoint('dunning_cron_invoice', () =>
          sendDunning({
            companyId,
            invoiceId,
            templateId: String(row.template_id),
            sentBy: null,
            triggerSource: 'cron',
            portalBaseUrl: options.portalBaseUrl,
          }),
        );
        if (sendResult.emailStatus === 'sent') {
          result.sent += 1;
        } else {
          result.failed += 1;
          result.errors.push(`invoice ${invoiceId}: ${sendResult.emailError ?? 'unknown'}`);
        }
      } catch (err) {
        result.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`invoice ${invoiceId}: ${msg}`);
        log.error('Dunning cron invoice failed', { invoiceId, msg }, 'dunningCron');
      }
    }
  }

  log.info('Dunning cron complete', {
    companiesChecked: result.companiesChecked,
    invoicesConsidered: result.invoicesConsidered,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed,
  }, 'dunningCron');
  return result;
}
