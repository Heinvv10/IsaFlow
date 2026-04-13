/**
 * GET /api/accounting/netcash/status?submissionId=
 * Poll Netcash for the current status of a submission.
 * Updates the record in netcash_submissions when a terminal state is returned.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSubmissionStatus } from '@/modules/accounting/services/ap/netcashService';

type Row = Record<string, unknown>;

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/** Map Netcash status strings to our internal enum values */
function mapNetcashStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('complete') || s.includes('success')) return 'completed';
  if (s.includes('fail') || s.includes('error') || s.includes('reject')) return 'failed';
  if (s.includes('process')) return 'processing';
  if (s.includes('submit')) return 'submitted';
  return 'processing';
}

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req;
  const { submissionId } = req.query;
  if (!submissionId) return apiResponse.badRequest(res, 'submissionId query param is required');

  // Load submission — company-scoped
  const submissions = await sql`
    SELECT id, batch_reference, status, netcash_response
    FROM netcash_submissions
    WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  ` as Row[];

  const submission = submissions[0];
  if (!submission) return apiResponse.notFound(res, 'Submission', String(submissionId));

  // If already terminal, return stored status without polling
  if (TERMINAL_STATUSES.has(String(submission.status))) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'Already in terminal state',
      polled: false,
    });
  }

  if (!submission.batch_reference) {
    return apiResponse.success(res, {
      submissionId,
      status: submission.status,
      detail: 'No batch reference available for polling',
      polled: false,
    });
  }

  // Load company credentials
  const companies = await sql`
    SELECT netcash_service_key FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  ` as Row[];
  const serviceKey = String(companies[0]?.netcash_service_key ?? '');

  const pollResult = await getSubmissionStatus(serviceKey, String(submission.batch_reference));
  const newStatus = mapNetcashStatus(pollResult.status);

  // Persist updated status
  await sql`
    UPDATE netcash_submissions
    SET status = ${newStatus},
        netcash_response = ${JSON.stringify({ ...((submission.netcash_response as Record<string, unknown>) ?? {}), latestPoll: pollResult })}::JSONB
    WHERE id = ${String(submissionId)}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Netcash status polled', { submissionId, newStatus, detail: pollResult.detail }, 'netcash-api');

  return apiResponse.success(res, {
    submissionId,
    status: newStatus,
    detail: pollResult.detail,
    polled: true,
    mock: pollResult.mock ?? false,
  });
}

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
