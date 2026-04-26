/**
 * POST /api/oauth/token — auth-code exchange and refresh-token rotation.
 *
 *   grant_type=authorization_code
 *     code, redirect_uri, code_verifier, client_id          (PKCE; secret optional)
 *
 *   grant_type=refresh_token
 *     refresh_token, client_id, client_secret               (confidential client)
 *
 * Bearer- and cookie-bypass — the credential is the (client_id, client_secret)
 * pair OR the PKCE verifier. Skips withCsrf (no cookie session, no CSRF risk).
 * No withAuth — this IS the auth issuance endpoint.
 */
import type { NextApiHandler } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import {
  exchangeCode,
  refreshAccessToken,
  verifyClientSecret,
  getOauthAppByClientId,
  OauthExchangeError,
} from '@/lib/auth/oauth';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  res.setHeader('Cache-Control', 'no-store');

  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : '';

  if (!clientId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
  }

  const app = await getOauthAppByClientId(clientId);
  if (!app) {
    log.warn('OAuth token: unknown client_id', { clientId }, 'oauth');
    return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client' });
  }

  try {
    if (grantType === 'authorization_code') {
      const code = typeof body.code === 'string' ? body.code : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
      const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      if (!code || !redirectUri || !codeVerifier) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code, redirect_uri, code_verifier required' });
      }

      // For confidential clients (those that have a secret), require it.
      // PKCE is mandatory regardless — the verifier is checked inside exchangeCode.
      if (clientSecret) {
        const ok = await verifyClientSecret(clientId, clientSecret);
        if (!ok) {
          log.warn('OAuth token: bad client_secret on auth-code grant', { clientId }, 'oauth');
          return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
        }
      }

      const tokens = await exchangeCode({ code, redirectUri, codeVerifier, oauthAppId: app.id });
      return res.status(200).json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.accessTokenExpiresIn,
        refresh_token: tokens.refreshToken || undefined,
        scope: tokens.scopes.join(' '),
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
      }
      // Refresh always requires client_secret — it's the only credential
      // available at refresh time (PKCE only applies to the code exchange).
      const ok = await verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      }

      const tokens = await refreshAccessToken({ refreshToken, clientId });
      return res.status(200).json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.accessTokenExpiresIn,
        refresh_token: tokens.refreshToken || undefined,
        scope: tokens.scopes.join(' '),
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type', error_description: `grant_type "${grantType}" is not supported` });
  } catch (err) {
    if (err instanceof OauthExchangeError) {
      return res.status(400).json({ error: err.code, error_description: err.message });
    }
    throw err;
  }
};

// Per-client rate limit on token issuance — 60/min/client beats brute-forcing
// of refresh tokens or auth codes.
export default withRateLimit(withErrorHandler(handler), { max: 60, windowSecs: 60 });
