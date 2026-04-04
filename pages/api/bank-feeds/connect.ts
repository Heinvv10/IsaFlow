/**
 * Bank Feeds — Initiate Connection
 * GET — returns Stitch OAuth authorization URL
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { getAuthorizationUrl, isConfigured } from '@/modules/accounting/services/bankFeedService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  if (!isConfigured()) {
    return apiResponse.badRequest(res, 'Bank feed integration not configured. Set STITCH_CLIENT_ID, STITCH_CLIENT_SECRET, and STITCH_REDIRECT_URI in environment.');
  }

  const { url, state, nonce, codeVerifier } = getAuthorizationUrl();

  // Store state + verifier in a secure cookie for the callback
  const stateData = JSON.stringify({ state, nonce, codeVerifier });
  res.setHeader('Set-Cookie', `stitch_oauth_state=${encodeURIComponent(stateData)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);

  return apiResponse.success(res, { url });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
