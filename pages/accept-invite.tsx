// pages/accept-invite.tsx
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { log } from '@/lib/logger';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export default function AcceptInvitePage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<{ email: string; role: string; company_name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The accept endpoint refuses to reset the password of an address that
  // already has an IsaFlow login (K-041); that person must type their EXISTING
  // password. The server tells us with SIGN_IN_REQUIRED, so relabel the field
  // rather than leaving them to guess from the error text.
  const [needsExistingPassword, setNeedsExistingPassword] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const r = await fetch(`/api/invitations/${token}`);
      // An outage answers 5xx with an empty or HTML body: say so, never a JSON parse error.
      const body = r.status >= 500 ? null : await r.json().catch(() => null);
      if (!body) { setError('Could not load the invitation - try again shortly'); setLoading(false); return; }
      if (!body.success) { setError(body.error?.message ?? 'This invitation is invalid or has expired'); setLoading(false); return; }
      setInvite(body.data);
      setLoading(false);
    })().catch(() => {
      // Audit N-class defect: a rejected fetch left `loading` true forever —
      // the invitee stared at the spinner with no feedback (P3.3 flagship).
      setError('Network error — could not load the invitation. Check your connection and refresh.');
      setLoading(false);
    });
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!needsExistingPassword && password.length < 10) { setError('Password must be at least 10 characters'); return; }
    if (password.length === 0) { setError('Password is required'); return; }
    setSubmitting(true); setError(null);
    let accepted = false;
    try {
      const r = await fetch(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, firstName, lastName }),
      });
      const body = r.status >= 500 ? null : await r.json().catch(() => null);
      if (!body) { setError('Could not accept the invitation - try again shortly'); return; }
      if (!body.success) {
        if (body.error?.code === 'SIGN_IN_REQUIRED') setNeedsExistingPassword(true);
        // A two-factor account accepts through the real sign-in, which asks for
        // the code and returns to /invite/<token> to join.
        if (body.error?.code === 'MFA_REQUIRED') {
          accepted = true; // keep the button disabled while the page changes
          void router.push(`/login?invite=${encodeURIComponent(token)}`);
          return;
        }
        setError(body.error?.message ?? 'Could not accept the invitation - try again'); return;
      }
      accepted = true;
    } catch {
      setError('Could not accept the invitation - try again');
    } finally {
      if (!accepted) setSubmitting(false);
    }
    if (!accepted) return;
    // The invite is accepted server-side. The navigation runs outside the try above so a
    // router abort is never reported as a failed accept; awaited, then the button is freed.
    try { await router.push('/accounting'); } catch (e) { log.warn('navigation failed', { error: e }, 'AcceptInvitePage'); }
    setSubmitting(false);
  }

  if (loading) {
    return (
      <AcceptInviteShell>
        <div className="flex items-center justify-center py-16"><LoadingSpinner size="lg" /></div>
      </AcceptInviteShell>
    );
  }
  if (!invite) {
    return (
      <AcceptInviteShell>
        <div className={CARD_CLASS + ' p-8 text-center'}>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Invitation Not Available</h1>
          <p className="text-sm text-slate-600 dark:text-gray-400">{error ?? 'This invitation is invalid, has already been used, or has expired.'}</p>
        </div>
      </AcceptInviteShell>
    );
  }

  return (
    <AcceptInviteShell>
      <div className={CARD_CLASS + ' overflow-hidden'}>
        <div className="bg-teal-900/30 border-b border-teal-800/50 px-6 py-5 text-center">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Join {invite.company_name}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-gray-400">
            as <span className="font-medium text-teal-600 dark:text-teal-300">{invite.role}</span>
          </p>
        </div>
        {/* autoComplete on every field: without it Chrome took "Last name" for the
            username and filled a saved login (email + password) of another site account. */}
        <form onSubmit={onSubmit} className="space-y-4 px-6 py-6">
          <p className="text-sm text-slate-600 dark:text-gray-400">
            {needsExistingPassword
              ? 'This address already has an IsaFlow account. Enter that account\u2019s password to accept.'
              : 'Set a password for your new IsaFlow login.'}
          </p>
          <label className="block">
            <span className={LABEL_CLASS}>Invited email</span>
            <input className={INPUT_CLASS + ' opacity-80'} value={invite.email} readOnly aria-readonly="true" autoComplete="off" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL_CLASS}>First name</span>
              <input name="given-name" autoComplete="given-name" className={INPUT_CLASS} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="block">
              <span className={LABEL_CLASS}>Last name</span>
              <input name="family-name" autoComplete="family-name" className={INPUT_CLASS} value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className={LABEL_CLASS}>
              {needsExistingPassword ? 'Your existing IsaFlow password' : 'Password (at least 10 characters)'}
            </span>
            {/* No minLength once the server has told us this address already has
                a login: that password was set elsewhere and may predate the
                10-character floor, which is a rule about setting one. */}
            <input
              type="password" name="password" className={INPUT_CLASS}
              autoComplete={needsExistingPassword ? 'current-password' : 'new-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={needsExistingPassword ? undefined : 10}
            />
          </label>
          {error && <div role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          <button
            type="submit" disabled={submitting}
            className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60 transition-colors"
          >
            {submitting ? 'Accepting…' : 'Accept invitation'}
          </button>
        </form>
      </div>
    </AcceptInviteShell>
  );
}

const CARD_CLASS = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl';
const LABEL_CLASS = 'mb-1 block text-sm font-medium text-slate-700 dark:text-gray-300';
const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm ' +
  'text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';

/** Same frame as /invite/[token], so the two steps of one invitation look like one flow. */
function AcceptInviteShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <img src="/logo.png" alt="ISAFlow" className="h-16 w-auto dark:brightness-0 dark:invert" />
        </div>
        {children}
      </div>
    </div>
  );
}
