// pages/accept-invite.tsx
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

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

  useEffect(() => {
    if (!token) return;
    (async () => {
      const r = await fetch(`/api/invitations/${token}`);
      const body = await r.json();
      if (!body.success) { setError(body.error?.message ?? 'Invalid invitation'); setLoading(false); return; }
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
    if (password.length < 10) { setError('Password must be at least 10 characters'); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch(`/api/invitations/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, firstName, lastName }),
      });
      const body = await r.json();
      if (!body.success) { setError(body.error?.message ?? 'Failed to accept'); setSubmitting(false); return; }
      // Not awaited: a router abort would land in the catch below and show
      // "could not submit" for an accept that already succeeded server-side.
      void router.push('/accounting/dashboard');
    } catch {
      setError('Network error — could not submit. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-8">Loading invitation…</div>;
  if (!invite) return <div className="p-8 text-red-600">{error ?? 'Invitation invalid or expired.'}</div>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-semibold mb-2">Join {invite.company_name}</h1>
        <p className="text-gray-600 mb-6">Invited as <strong>{invite.role}</strong> with email <strong>{invite.email}</strong>. Set your password to accept.</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm">First name</span>
              <input className="w-full border rounded p-2" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm">Last name</span>
              <input className="w-full border rounded p-2" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="text-sm">Password (at least 10 characters)</span>
            <input type="password" className="w-full border rounded p-2" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </label>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button type="submit" disabled={submitting} className="w-full bg-indigo-600 text-white rounded p-2 disabled:opacity-50">
            {submitting ? 'Accepting…' : 'Accept invitation'}
          </button>
        </form>
      </div>
    </div>
  );
}
