/**
 * Widget Layout API
 * GET  /api/accounting/widget-layout  — Returns saved widget layout (or adaptive default)
 * POST /api/accounting/widget-layout  — Saves widget layout to user_preferences
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { WidgetConfig } from '@/components/dashboard/widgetTypes';
import { DEFAULT_WIDGET_LAYOUT } from '@/components/dashboard/widgetTypes';

const PREF_KEY = 'dashboard_widget_layout';

async function buildAdaptiveDefault(companyId: string): Promise<WidgetConfig[]> {
  const layout: WidgetConfig[] = [
    { id: 'quick-actions-1', type: 'quick-actions', title: 'Quick Actions', size: 'md' },
  ];

  const [bankRows, invoiceRows, supplierRows] = await Promise.all([
    sql`SELECT id FROM gl_accounts WHERE company_id = ${companyId} AND account_subtype = 'bank' AND is_active = true LIMIT 1`,
    sql`SELECT id FROM customer_invoices WHERE company_id = ${companyId} LIMIT 1`,
    sql`SELECT id FROM supplier_invoices WHERE company_id = ${companyId} LIMIT 1`,
  ]);

  if ((bankRows as unknown[]).length > 0) {
    layout.push({ id: 'bank-summary-1', type: 'bank-summary', title: 'Bank Accounts', size: 'md' });
  }
  if ((invoiceRows as unknown[]).length > 0) {
    layout.push({ id: 'invoices-owed-1', type: 'invoices-owed', title: 'Invoices Owed', size: 'sm' });
  }
  if ((supplierRows as unknown[]).length > 0) {
    layout.push({ id: 'bills-to-pay-1', type: 'bills-to-pay', title: 'Bills to Pay', size: 'sm' });
  }

  layout.push(
    { id: 'pnl-snapshot-1', type: 'pnl-snapshot', title: 'P&L Snapshot', size: 'md' },
    { id: 'recent-activity-1', type: 'recent-activity', title: 'Recent Activity', size: 'sm' },
  );

  return layout;
}

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT value FROM user_preferences
        WHERE user_id = ${userId} AND key = ${PREF_KEY}
        LIMIT 1
      `;

      const existing = (rows as { value: string }[]);
      const firstRow = existing[0];
      if (firstRow?.value) {
        const saved = JSON.parse(firstRow.value) as WidgetConfig[];
        return apiResponse.success(res, { layout: saved, isDefault: false });
      }

      // Build adaptive default based on company data
      const layout = await buildAdaptiveDefault(companyId);
      return apiResponse.success(res, { layout, isDefault: true });
    } catch (err) {
      log.error('Failed to load widget layout', { error: err, companyId }, 'widget-layout');
      // Fall back to static default on error
      return apiResponse.success(res, { layout: DEFAULT_WIDGET_LAYOUT, isDefault: true });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const body = req.body as { layout?: unknown };
      if (!body.layout || !Array.isArray(body.layout)) {
        return apiResponse.badRequest(res, 'layout array is required');
      }

      const layout = body.layout as WidgetConfig[];
      const value = JSON.stringify(layout);

      await sql`
        INSERT INTO user_preferences (user_id, key, value, updated_at)
        VALUES (${userId}, ${PREF_KEY}, ${value}, NOW())
        ON CONFLICT (user_id, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      log.info('Widget layout saved', { userId, widgetCount: layout.length }, 'widget-layout');
      return apiResponse.success(res, { saved: true, widgetCount: layout.length });
    } catch (err) {
      log.error('Failed to save widget layout', { error: err, companyId }, 'widget-layout');
      return apiResponse.badRequest(res, 'Failed to save widget layout');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
