/**
 * GET/POST /api/accounting/mcp-connector-setting: the session company's MCP connector switch.
 *
 * GET (any member): { enabled, lockedByPlatform, canToggle }.
 * POST { enabled: boolean } (owner or admin of the session company; CSRF): switches it through
 * mcp_connector_self_serve_set (migration 1056), which checks the session company and the role again in SQL. The
 * company is always req.companyId: a body naming any other field (companyId included) is 400. Answers: 200 the
 * GET payload; 400 bad body; 403 role (or the SQL function refused); 409 switched off by IsaFlow (a platform
 * admin's OFF is a lock owners cannot lift). A real change writes one audit_log row in the request transaction.
 * Precedence: src/lib/mcp/connectorSetting.ts.
 */
import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isFullAccessRole } from '@/lib/auth/companyRoles';
import { trustedClientIp } from '@/lib/trustedClientIp';
import { getConnectorSetting, setConnectorSelfServe } from '@/lib/mcp/connectorSetting';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';

export const LOCKED_BY_PLATFORM_MESSAGE = 'Switched off by IsaFlow. Contact IsaFlow support.';

const Body = z.object({ enabled: z.boolean() }).strict();

async function payload(companyId: string, role: string) {
  return { ...(await getConnectorSetting(companyId)), canToggle: isFullAccessRole(role) };
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (req.method === 'GET') return apiResponse.success(res, await payload(companyId, companyRole));
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.badRequest(res, 'Send { enabled: true } or { enabled: false } only.');

  const outcome = await setConnectorSelfServe(companyId, parsed.data.enabled);
  if (outcome.result === 'forbidden') return apiResponse.forbidden(res, 'Only a company owner or admin can change this.');
  if (outcome.result === 'locked') return apiResponse.conflict(res, LOCKED_BY_PLATFORM_MESSAGE);

  if (outcome.result === 'ok') {
    await logAuditOrThrow({
      companyId,
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'update',
      entityType: 'company_feature',
      entityId: companyId,
      entityRef: 'mcp_connector',
      changes: {
        fields: [{
          field: 'enabled',
          old: outcome.wasEnabled === null ? null : String(outcome.wasEnabled),
          new: String(parsed.data.enabled),
          label: 'MCP connector',
        }],
        metadata: {
          event: 'company_feature.override_set',
          set_via: 'company_admin',
          previous_set_via: outcome.wasSetVia ?? 'none',
        },
      },
      ip: trustedClientIp(req) ?? undefined,
      userAgent: req.headers['user-agent'],
    });
  }
  return apiResponse.success(res, await payload(companyId, companyRole));
}

// The literal is FULL_ACCESS_ROLES (companyRoles.ts); the role-gate census reads literals.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
