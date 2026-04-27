/**
 * GET  /api/auth/personal-tokens — list this user's PATs for active company
 * POST /api/auth/personal-tokens — mint a new PAT (raw value returned once)
 *
 * PAT mint/list/revoke is intentionally cookie-only (withAuth, no Bearer
 * fallback) — issuing a new PAT via a stolen PAT would be a privilege
 * escalation primitive.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { createPat, listPats, PAT_SCOPES } from '@/lib/auth/personalAccessTokens';

const VALID_SCOPES = new Set<string>(PAT_SCOPES);
const MAX_NAME_LEN = 80;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { user, companyId } = req;
  const userId = user.id;

  if (req.method === 'GET') {
    const tokens = await listPats(userId, companyId);
    return apiResponse.success(res, tokens);
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const scopesRaw = Array.isArray(body.scopes) ? body.scopes : [];
    const expiresInDays =
      typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)
        ? body.expiresInDays
        : DEFAULT_DAYS;

    if (!name) return apiResponse.badRequest(res, 'name is required');
    if (name.length > MAX_NAME_LEN) {
      return apiResponse.badRequest(res, `name must be ${MAX_NAME_LEN} characters or fewer`);
    }
    if (expiresInDays < MIN_DAYS || expiresInDays > MAX_DAYS) {
      return apiResponse.badRequest(res, `expiresInDays must be between ${MIN_DAYS} and ${MAX_DAYS}`);
    }

    const scopes: string[] = [];
    for (const s of scopesRaw) {
      if (typeof s !== 'string') return apiResponse.badRequest(res, 'scopes must be an array of strings');
      if (!VALID_SCOPES.has(s)) return apiResponse.badRequest(res, `unknown scope: ${s}`);
      if (!scopes.includes(s)) scopes.push(s);
    }
    if (scopes.length === 0) {
      return apiResponse.badRequest(res, 'at least one scope is required');
    }

    const result = await createPat({ userId, companyId, name, scopes, expiresInDays });

    log.info('PAT minted', { userId, companyId, name, scopes, expiresInDays }, 'pat');

    // Raw token returned here — NEVER stored, NEVER logged.
    return apiResponse.created(res, {
      id: result.id,
      name,
      scopes,
      prefix: result.prefix,
      token: result.raw,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler as Parameters<typeof withErrorHandler>[0])));
