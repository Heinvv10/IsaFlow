/**
 * Audit Log Export API
 * GET /api/accounting/audit-log-export — Download audit log as CSV
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getAuditLog,
  logAudit,
  type AuditLogItem,
} from '@/modules/accounting/services/auditTrailService';
import { escapeCsv } from '@/lib/csv';

function formatChanges(item: AuditLogItem): string {
  if (!item.changes?.fields?.length) return '';
  return item.changes.fields
    .map(f => `${f.label}: ${f.old ?? '(empty)'} → ${f.new ?? '(empty)'}`)
    .join(' | ');
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    try {
      const {
        entity_type,
        entity_id,
        user_id,
        action,
        date_from,
        date_to,
        search,
      } = req.query;

      // Fetch up to 10,000 rows for export
      const result = await getAuditLog(companyId, {
        entityType: entity_type as string | undefined,
        entityId: entity_id as string | undefined,
        userId: user_id as string | undefined,
        action: action as string | undefined,
        dateFrom: date_from as string | undefined,
        dateTo: date_to as string | undefined,
        search: search as string | undefined,
        limit: 10000,
        offset: 0,
      });

      // Log the export action itself
      void logAudit({
        companyId,
        userId: req.user.id,
        userEmail: req.user.email,
        action: 'export',
        entityType: 'audit_log',
        entityId: companyId,
        entityRef: 'audit-trail-export',
        ip: req.headers['x-forwarded-for'] as string ?? req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
      });

      const headers = [
        'Date/Time',
        'User',
        'Action',
        'Entity Type',
        'Reference',
        'Changes',
        'IP Address',
      ];

      const csvRows = [
        headers.map(escapeCsv).join(','),
        ...result.items.map((item: AuditLogItem) =>
          [
            escapeCsv(item.createdAt),
            escapeCsv(item.userEmail ?? item.userId),
            escapeCsv(item.action),
            escapeCsv(item.entityType),
            escapeCsv(item.entityRef),
            escapeCsv(formatChanges(item)),
            escapeCsv(item.ipAddress),
          ].join(','),
        ),
      ];

      const csv = csvRows.join('\n');
      const filename = `audit-trail-${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(csv);
      return;
    } catch (err) {
      log.error('Failed to export audit log', { error: err }, 'audit-log-export-api');
      return apiResponse.internalError(res, err, 'Failed to export audit log');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
