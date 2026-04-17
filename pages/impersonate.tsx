/**
 * /impersonate — Impersonation token landing page
 *
 * Admin clicks "Login As" in the admin console → opens
 * app.isaflow.co.za/impersonate?token=<jwt>
 *
 * getServerSideProps exchanges the token for a cookie server-side,
 * then redirects to /accounting. No client-side flash.
 *
 * On failure: shows a clean error page with a link back to the admin console.
 */

import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { verifyToken } from '@/lib/auth/jwt';
import { sql } from '@/lib/neon';
import { serialize } from 'cookie';
import { AUTH_COOKIE_NAME } from '@/lib/auth/middleware';
import { log } from '@/lib/logger';
import crypto from 'crypto';

type Row = Record<string, unknown>;

interface Props {
  error: string;
}

export default function ImpersonatePage({ error }: Props) {
  return (
    <>
      <Head><title>Impersonation Error — ISAFlow</title></Head>
      <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-900 rounded-xl border border-red-800/40 p-8 text-center">
          <div className="w-12 h-12 bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white mb-2">Impersonation failed</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">{error}</p>
          <Link
            href="https://admin.isaflow.co.za"
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-600 text-slate-900 dark:text-white text-sm rounded-lg transition-colors"
          >
            ← Back to Admin Console
          </Link>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const token = ctx.query.token as string | undefined;

  if (!token) {
    return { props: { error: 'No impersonation token provided.' } };
  }

  try {
    // Verify JWT
    const payload = await verifyToken(token);
    if (!payload) {
      return { props: { error: 'Token is invalid or has expired.' } };
    }

    // Verify session exists, unexpired, and was created via admin impersonation
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const rows = (await sql`
      SELECT id, metadata
      FROM user_sessions
      WHERE token_hash = ${tokenHash}
        AND expires_at > NOW()
      LIMIT 1
    `) as Row[];

    const session = rows[0];
    if (!session) {
      return { props: { error: 'Impersonation session not found or has expired.' } };
    }

    const metadata = session.metadata as Record<string, unknown> | null;
    if (!metadata?.impersonated_by) {
      return { props: { error: 'This token was not issued by admin impersonation.' } };
    }

    // Set auth cookie
    const isProd = process.env.NODE_ENV === 'production';
    const cookie = serialize(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60,
      ...(isProd ? { domain: '.isaflow.co.za' } : {}),
    });

    ctx.res.setHeader('Set-Cookie', cookie);

    log.info('Impersonation session activated via landing page', {
      targetUserId: payload.sub,
      impersonatedBy: metadata.impersonated_by,
    }, 'impersonate-page');

    return {
      redirect: {
        destination: '/accounting',
        permanent: false,
      },
    };
  } catch (err) {
    log.error('Impersonation exchange error', { error: err }, 'impersonate-page');
    return { props: { error: 'An unexpected error occurred. Please try again.' } };
  }
};
