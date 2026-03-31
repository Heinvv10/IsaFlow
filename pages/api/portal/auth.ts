/**
 * Client Portal — Authentication API
 * POST — login with email/password, sets signed httpOnly session cookie
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { authenticatePortalUser } from '@/modules/accounting/services/portalService';
import { SignJWT } from 'jose';
import cookie from 'cookie';
import { checkRateLimit } from '@/lib/rateLimit';

const PORTAL_SECRET = new TextEncoder().encode(
  (() => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required'); return process.env.JWT_SECRET + '-portal'; })()
);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  // Rate limit: 5 attempts per IP per 15 minutes
  const rawIp = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  const ip: string = rawIp ?? 'unknown';
  if (checkRateLimit(ip, { windowMs: 15 * 60 * 1000, maxRequests: 5 })) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return apiResponse.badRequest(res, 'email and password are required');
  }

  const user = await authenticatePortalUser(email, password);
  if (!user) {
    return apiResponse.unauthorized(res, 'Invalid email or password');
  }

  // Sign a JWT for the portal session
  const token = await new SignJWT({ clientId: user.clientId, email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .setIssuedAt()
    .sign(PORTAL_SECRET);

  // Set httpOnly signed cookie
  res.setHeader('Set-Cookie', cookie.serialize('portal_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  }));

  return apiResponse.success(res, { user });
}

export default withErrorHandler(handler);
