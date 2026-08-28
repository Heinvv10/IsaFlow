/**
 * POST /api/oauth/token — auth-code exchange and refresh-token rotation.
 *
 *   grant_type=authorization_code
 *     code, redirect_uri, code_verifier, client_id        (+ client_secret if confidential)
 *
 *   grant_type=refresh_token
 *     refresh_token, client_id, client_secret             (always required for refresh)
 *
 * Bypasses withCsrf and withAuth — credentials are (client_id, client_secret)
 * + PKCE verifier. Accepts both application/json AND application/x-www-form-
 * urlencoded bodies (RFC 6749 §4.1.3 mandates form-encoded; many OAuth
 * libraries default to that). Next's default body parser handles JSON; we
 * manually parse form-encoded when the Content-Type matches.
 */
import type { NextApiHandler, NextApiRequest } from 'next';
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

// Disable Next's default body parser when the body is form-encoded — we want
// to parse it ourselves so we can read raw bytes deterministically.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8kb',
    },
  },
};

interface TokenRequest {
  grant_type?: string;
  client_id?: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
}

function parseBody(req: NextApiRequest): TokenRequest {
  const ct = (req.headers['content-type'] ?? '').toLowerCase();

  // application/json — Next has already populated req.body
  if (ct.includes('application/json')) {
    return (req.body ?? {}) as TokenRequest;
  }

  // application/x-www-form-urlencoded — Next parses this into an object
  // automatically too (urlencoded() is the default for that content type).
  if (ct.includes('application/x-www-form-urlencoded')) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out: TokenRequest = {};
    for (const k of [
      'grant_type', 'client_id', 'client_secret',
      'code', 'redirect_uri', 'code_verifier', 'refresh_token',
    ] as const) {
      const v = body[k];
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  // Unknown content type — return empty so the caller hits a 400 invalid_request.
  return {};
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  res.setHeader('Cache-Control', 'no-store');

  const body = parseBody(req);
  const grantType = body.grant_type ?? '';
  const clientId = body.client_id ?? '';
  const clientSecret = body.client_secret ?? '';

  if (!clientId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
  }

  const app = await getOauthAppByClientId(clientId);
  if (!app) {
    log.warn('OAuth token: unknown client_id', { clientId }, 'oauth');
    res.setHeader('WWW-Authenticate', 'Basic realm="ISAFlow"');
    return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client' });
  }

  try {
    if (grantType === 'authorization_code') {
      const code = body.code ?? '';
      const redirectUri = body.redirect_uri ?? '';
      const codeVerifier = body.code_verifier ?? '';
      if (!code || !redirectUri || !codeVerifier) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'code, redirect_uri, code_verifier required',
        });
      }

      // Confidential clients (those that registered a client_secret) MUST
      // present it on the auth-code grant — PKCE alone isn't sufficient
      // client authentication for confidential clients (RFC 8252 §8.6).
      if (app.isConfidential) {
        if (!clientSecret) {
          res.setHeader('WWW-Authenticate', 'Basic realm="ISAFlow"');
          return res.status(401).json({
            error: 'invalid_client',
            error_description: 'client_secret is required for this client',
          });
        }
        const ok = await verifyClientSecret(clientId, clientSecret);
        if (!ok) {
          log.warn('OAuth token: bad client_secret on auth-code grant', { clientId }, 'oauth');
          res.setHeader('WWW-Authenticate', 'Basic realm="ISAFlow"');
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
      const refreshToken = body.refresh_token ?? '';
      if (!refreshToken) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
      }
      // Refresh always requires client_secret for confidential clients (no
      // PKCE in refresh flows).
      if (app.isConfidential) {
        const ok = await verifyClientSecret(clientId, clientSecret);
        if (!ok) {
          res.setHeader('WWW-Authenticate', 'Basic realm="ISAFlow"');
          return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
        }
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

    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `grant_type "${grantType}" is not supported`,
    });
  } catch (err) {
    if (err instanceof OauthExchangeError) {
      return res.status(400).json({ error: err.code, error_description: err.message });
    }
    throw err;
  }
};

export default withRateLimit(withErrorHandler(handler), { max: 60, windowSecs: 60 }, 'oauth-token');
