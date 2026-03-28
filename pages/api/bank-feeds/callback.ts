/**
 * Bank Feeds — OAuth Callback
 * Handles the redirect from Stitch after user authorizes bank access.
 * Exchanges code for tokens, fetches accounts, creates connection.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  exchangeCode, fetchStitchAccounts, createConnection,
} from '@/modules/accounting/services/bankFeedService';
import cookie from 'cookie';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { code, state, error } = req.query;

  if (error) {
    // User cancelled or Stitch returned error
    return res.redirect('/accounting/bank-accounts?feed_error=' + encodeURIComponent(String(error)));
  }

  if (!code || !state) {
    return apiResponse.badRequest(res, 'Missing code or state parameter');
  }

  // Retrieve stored state + code verifier from cookie
  const cookies = cookie.parse(req.headers.cookie || '');
  const rawState = cookies.stitch_oauth_state;
  if (!rawState) {
    return apiResponse.badRequest(res, 'OAuth state cookie missing. Please try connecting again.');
  }

  let storedState: { state: string; codeVerifier: string };
  try {
    storedState = JSON.parse(decodeURIComponent(rawState));
  } catch {
    return apiResponse.badRequest(res, 'Invalid OAuth state');
  }

  if (storedState.state !== state) {
    return apiResponse.badRequest(res, 'OAuth state mismatch — possible CSRF attack');
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;

  // Exchange code for tokens
  const tokens = await exchangeCode(String(code), storedState.codeVerifier);

  // Fetch linked bank accounts
  const accounts = await fetchStitchAccounts(tokens.accessToken);

  // Clear the state cookie
  res.setHeader('Set-Cookie', 'stitch_oauth_state=; Path=/; HttpOnly; Max-Age=0');

  // Store accounts info and redirect to bank accounts page with success
  // In a real flow, user would select which account to link.
  // For now, store the first account or return the list for selection.

  if (accounts.length === 0) {
    return res.redirect('/accounting/bank-accounts?feed_error=no_accounts');
  }

  // Return accounts for the user to select which to link
  // Store tokens temporarily in the session
  const bankAccountId = req.query.bankAccountId as string;
  if (bankAccountId) {
    // Direct link — create connection immediately
    const account = accounts[0]!;
    await createConnection({
      bankAccountId,
      externalAccountId: account.id,
      bankName: account.bankId,
      accountNumberMasked: account.accountNumber,
      branchCode: account.branchCode,
      accountType: account.accountType,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      createdBy: userId,
    });
    return res.redirect('/accounting/bank-accounts?feed_connected=true');
  }

  // Return accounts for selection
  return apiResponse.success(res, {
    accounts,
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
