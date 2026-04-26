/**
 * GET  /api/developer/oauth-apps — list this user's registered OAuth apps.
 * POST /api/developer/oauth-apps — register a new app (returns client_secret once).
 *
 * Cookie-only. App registration is a developer-side action that always
 * happens in a browser session; never via PAT or OAuth itself.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listOauthApps, registerOauthApp } from '@/lib/auth/oauth';

const MAX_NAME_LEN = 80;
const MAX_DESC_LEN = 500;
const MAX_REDIRECTS = 10;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const userId = req.user.id;

  if (req.method === 'GET') {
    const apps = await listOauthApps(userId);
    return apiResponse.success(res, apps);
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : null;
    const logoUrl = typeof body.logoUrl === 'string' ? body.logoUrl.trim() : null;
    const homepageUrl = typeof body.homepageUrl === 'string' ? body.homepageUrl.trim() : null;
    const redirectUris = Array.isArray(body.redirectUris) ? body.redirectUris : [];

    if (!name) return apiResponse.badRequest(res, 'name is required');
    if (name.length > MAX_NAME_LEN) return apiResponse.badRequest(res, `name must be ≤ ${MAX_NAME_LEN} characters`);
    if (description && description.length > MAX_DESC_LEN) {
      return apiResponse.badRequest(res, `description must be ≤ ${MAX_DESC_LEN} characters`);
    }
    if (redirectUris.length === 0) return apiResponse.badRequest(res, 'At least one redirect URI is required');
    if (redirectUris.length > MAX_REDIRECTS) {
      return apiResponse.badRequest(res, `At most ${MAX_REDIRECTS} redirect URIs allowed`);
    }

    const cleanUris: string[] = [];
    for (const u of redirectUris) {
      if (typeof u !== 'string') return apiResponse.badRequest(res, 'redirectUris must be strings');
      try {
        const url = new URL(u);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
          return apiResponse.badRequest(res, `redirectUri "${u}" must use https (except localhost)`);
        }
        cleanUris.push(u);
      } catch {
        return apiResponse.badRequest(res, `Invalid redirect URI: ${u}`);
      }
    }

    const result = await registerOauthApp({
      ownerUserId: userId,
      name,
      description: description || null,
      logoUrl: logoUrl || null,
      homepageUrl: homepageUrl || null,
      redirectUris: cleanUris,
    });

    // client_secret returned once — NEVER stored, NEVER logged.
    return apiResponse.created(res, {
      id: result.id,
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      name,
      redirectUris: cleanUris,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));
