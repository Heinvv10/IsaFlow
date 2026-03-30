/**
 * /invite/[token] — Invitation landing page.
 * Public page (no AppLayout). Validates the token and lets the user
 * sign in, register, or (if already logged in) accept directly.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Building2, UserCheck, LogIn, UserPlus, AlertTriangle, Loader2 } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface InviteData {
  email: string;
  companyName: string;
  role: string;
  invitedBy: string;
}

interface AuthUser {
  id: string;
  email: string;
}

type PageState = 'loading' | 'valid' | 'invalid' | 'accepting' | 'accepted' | 'error';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner', admin: 'Administrator', manager: 'Manager', viewer: 'Viewer',
};

export default function InvitePage() {
  const router = useRouter();
  const { token } = router.query as { token?: string };

  const [pageState, setPageState] = useState<PageState>('loading');
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Load invite info + check current auth state in parallel
  useEffect(() => {
    if (!token) return;

    async function load() {
      try {
        const [inviteRes, meRes] = await Promise.all([
          fetch(`/api/invite/${token}`),
          fetch('/api/auth/me'),
        ]);

        if (!inviteRes.ok) {
          setPageState('invalid');
          return;
        }

        const inviteJson = await inviteRes.json() as { data: InviteData };
        setInviteData(inviteJson.data);

        if (meRes.ok) {
          const meJson = await meRes.json() as { data: { user: AuthUser } };
          setCurrentUser(meJson.data?.user ?? null);
        }

        setPageState('valid');
      } catch {
        setPageState('error');
        setErrorMsg('Failed to load invitation. Please try again.');
      }
    }

    void load();
  }, [token]);

  async function handleAccept() {
    if (!token) return;
    setPageState('accepting');

    try {
      const res = await fetch(`/api/invite/${token}`, { method: 'POST' });
      const json = await res.json() as { success: boolean; error?: { message: string } };

      if (!res.ok) {
        setErrorMsg(json.error?.message ?? 'Failed to accept invitation');
        setPageState('error');
        return;
      }

      setPageState('accepted');
      // Give a moment to show success, then redirect
      setTimeout(() => { void router.push('/accounting'); }, 1500);
    } catch {
      setErrorMsg('Network error. Please try again.');
      setPageState('error');
    }
  }

  const roleLabel = inviteData ? (ROLE_LABELS[inviteData.role] ?? inviteData.role) : '';

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/logo.png" alt="ISAFlow" className="h-16 w-auto brightness-0 invert mb-4" />
        </div>

        {/* Loading state */}
        {pageState === 'loading' && (
          <div className="flex items-center justify-center py-16">
            <LoadingSpinner size="lg" />
          </div>
        )}

        {/* Invalid token */}
        {pageState === 'invalid' && (
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 text-center shadow-xl">
            <AlertTriangle className="h-12 w-12 text-amber-400 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-white mb-2">Invitation Not Found</h1>
            <p className="text-gray-400 text-sm mb-6">
              This invitation link is invalid, has already been used, or has expired.
            </p>
            <Link
              href="/login"
              className="inline-block rounded-lg bg-teal-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-teal-500 transition-colors"
            >
              Go to Sign In
            </Link>
          </div>
        )}

        {/* Error state */}
        {pageState === 'error' && (
          <div className="bg-gray-900 border border-red-800 rounded-2xl p-8 text-center shadow-xl">
            <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-white mb-2">Something Went Wrong</h1>
            <p className="text-gray-400 text-sm mb-6">{errorMsg}</p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-gray-700 px-6 py-2.5 text-sm font-medium text-white hover:bg-gray-600 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Accepted */}
        {pageState === 'accepted' && (
          <div className="bg-gray-900 border border-teal-700 rounded-2xl p-8 text-center shadow-xl">
            <UserCheck className="h-12 w-12 text-teal-400 mx-auto mb-4" />
            <h1 className="text-xl font-bold text-white mb-2">Welcome Aboard!</h1>
            <p className="text-gray-400 text-sm">
              You have joined{' '}
              <span className="text-white font-medium">{inviteData?.companyName}</span>.
              Redirecting to your dashboard…
            </p>
          </div>
        )}

        {/* Valid invitation card */}
        {(pageState === 'valid' || pageState === 'accepting') && inviteData && (
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-xl overflow-hidden">

            {/* Header */}
            <div className="bg-teal-900/30 border-b border-teal-800/50 px-6 py-5 text-center">
              <Building2 className="h-10 w-10 text-teal-400 mx-auto mb-3" />
              <h1 className="text-xl font-bold text-white mb-1">You&apos;re Invited!</h1>
              <p className="text-sm text-gray-400">
                <span className="text-gray-300">{inviteData.invitedBy}</span> has invited you to join
              </p>
              <p className="text-lg font-semibold text-teal-300 mt-1">{inviteData.companyName}</p>
            </div>

            {/* Role badge */}
            <div className="px-6 py-4 flex items-center justify-center gap-2 border-b border-gray-800">
              <span className="text-sm text-gray-400">as</span>
              <span className="inline-flex rounded-full bg-teal-900 px-3 py-1 text-sm font-medium text-teal-300">
                {roleLabel}
              </span>
            </div>

            <div className="px-6 py-6 space-y-3">

              {/* Already logged in — show Join button */}
              {currentUser ? (
                <>
                  <p className="text-center text-sm text-gray-400 mb-4">
                    Signed in as{' '}
                    <span className="text-white">{currentUser.email}</span>
                  </p>
                  <button
                    onClick={() => void handleAccept()}
                    disabled={pageState === 'accepting'}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-60 transition-colors"
                  >
                    {pageState === 'accepting' ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Joining…</span>
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-4 w-4" />
                        <span>Join {inviteData.companyName}</span>
                      </>
                    )}
                  </button>
                  <p className="text-center text-xs text-gray-600 pt-1">
                    Not you?{' '}
                    <Link href="/login" className="text-teal-500 hover:text-teal-400">
                      Sign In with a Different Account
                    </Link>
                  </p>
                </>
              ) : (
                /* Not logged in — two CTAs */
                <>
                  <Link
                    href={`/login?invite=${token}`}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-medium text-white hover:bg-teal-500 transition-colors"
                  >
                    <LogIn className="h-4 w-4" />
                    Sign In to Accept
                  </Link>
                  <Link
                    href={`/register?invite=${token}`}
                    className="w-full flex items-center justify-center gap-2 rounded-lg border border-gray-600 px-4 py-3 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
                  >
                    <UserPlus className="h-4 w-4" />
                    Create an Account
                  </Link>
                  <p className="text-center text-xs text-gray-600 pt-1">
                    Invitation sent to{' '}
                    <span className="text-gray-400">{inviteData.email}</span>
                  </p>
                </>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
