/**
 * /employee-portal/accept#t=<token> (wave 6 SS): the invitation link. The token rides in the URL fragment, so it never
 * reaches a server log; the page reads it and posts it with the chosen password, then signs the employee in.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PortalShell } from '@/components/employeePortal/PortalShell';
import { portalCall } from '@/components/employeePortal/portalFetch';

export default function EmployeePortalAccept() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Wait for the router: on a statically optimised page Next replaces the URL (hash included) once it is ready,
    // which would put the token back after a plain history.replaceState.
    if (!router.isReady) return;
    const t = new URLSearchParams(window.location.hash.slice(1)).get('t');
    // Once read, the token stays in state even when this runs again after the hash is gone.
    setToken((prev) => t ?? prev ?? '');
    // Off the address bar and out of history once read.
    if (t) void router.replace(window.location.pathname, undefined, { shallow: true });
  }, [router, router.isReady]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) { setError('The two passwords are not the same.'); return; }
    setBusy(true);
    setError('');
    try {
      await portalCall('/api/employee-portal/accept', { method: 'POST', body: { token, password } });
      await router.push('/employee-portal');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalShell title="Choose your password">
      {token === '' ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">This link is not complete. Open it again from your invitation email.</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="max-w-sm space-y-4">
          <Input label="New password" type="password" autoComplete="new-password" required minLength={10} value={password}
            onChange={(e) => setPassword(e.target.value)} helperText="At least 10 characters." />
          <Input label="Type it again" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button type="submit" loading={busy} disabled={token === null} className="w-full">Set password and sign in</Button>
        </form>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </PortalShell>
  );
}
