/**
 * /employee-portal/login (wave 6 SS): an employee signs in with the address their employer invited and the password
 * they chose. A password that opens logins at several employers asks which one (CHOOSE_EMPLOYER).
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PortalShell } from '@/components/employeePortal/PortalShell';
import { portalCall, PortalCallError } from '@/components/employeePortal/portalFetch';
import { apiErrorMessage } from '@/lib/apiFetch';

type Employer = { accessId: string; employer: string };

export default function EmployeePortalLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Employer[] | null>(null);

  async function signIn(accessId?: string): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await portalCall('/api/employee-portal/login', 'Could not sign in. Please try again.', { method: 'POST', body: { email, password, ...(accessId ? { accessId } : {}) } });
      await router.push('/employee-portal');
    } catch (err) {
      if (err instanceof PortalCallError && err.reason === 'CHOOSE_EMPLOYER') setChoices((err.details?.employers as Employer[]) ?? []);
      else setError(apiErrorMessage(err, 'Could not sign in. Please try again.'));
    } finally {
      setBusy(false);
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void signIn(); };

  return (
    <PortalShell title="Sign in">
      {choices ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-700 dark:text-gray-300">Your details open more than one employer. Choose one:</p>
          {choices.map((c) => (
            <Button key={c.accessId} variant="secondary" className="w-full" disabled={busy} onClick={() => void signIn(c.accessId)}>{c.employer}</Button>
          ))}
        </div>
      ) : (
        <form onSubmit={submit} className="max-w-sm space-y-4">
          <Input label="Email address" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        </form>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <p className="mt-6 text-sm text-gray-600 dark:text-gray-300">New here? Use the link in your invitation email. Forgot your password? Ask your employer to invite you again.</p>
    </PortalShell>
  );
}
