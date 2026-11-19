/**
 * The employee self-service portal on the employee page (wave 6 SS; mounted on the work card by one line, as PE's
 * EmployeeEmailField). Shows the company's two switches (the platform's, read-only; the company's, which an owner or
 * admin may set) and this employee's portal login, with Invite / Invite again / End access for an owner or admin.
 * The routes judge everything (role, Login-as, switches, address, leaver window); this only shows their answers.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

interface PortalState { platformEnabled: boolean; enabled: boolean }
interface Access {
  status: 'none' | 'invited' | 'active' | 'revoked'; email: string | null; inviteExpiresAt: string | null;
  lastLoginAt: string | null; accessEnds: string | null | 'closed';
}

const LOAD_FAILED = 'Could not load the employee portal details';
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const STATUS: Record<Access['status'], string> = {
  none: 'Not invited', invited: 'Invited, has not signed in yet', active: 'Uses the portal', revoked: 'Access ended',
};

export function EmployeePortalCard({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const [state, setState] = useState<PortalState | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setState(await apiJson('/api/payroll/settings/employee-portal', undefined, LOAD_FAILED) as PortalState);
      setAccess(await apiJson(`/api/payroll/employees/${employeeId}/portal-access`, undefined, LOAD_FAILED) as Access);
    } catch (err) {
      setError(apiErrorMessage(err, LOAD_FAILED));
    }
  }, [employeeId]);
  useEffect(() => { void load(); }, [load]);

  async function act(url: string, method: 'PUT' | 'POST' | 'DELETE', body: unknown, done: (d: unknown) => string, fail: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const d = await apiJson(url, { method, body: JSON.stringify(body) }, fail);
      setMessage(done(d));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, fail));
    } finally {
      setBusy(false);
    }
  }

  const invite = () => act(`/api/payroll/employees/${employeeId}/portal-access`, 'POST', {},
    (d) => ((d as { sent?: boolean }).sent ? 'Invitation sent.' : 'The invitation email could not be sent. Invite again.'),
    'Could not send the invitation - try again');
  const revoke = () => act(`/api/payroll/employees/${employeeId}/portal-access`, 'DELETE', {}, () => 'Portal access ended.',
    'Could not end portal access - try again');
  const toggle = (enabled: boolean) => act('/api/payroll/settings/employee-portal', 'PUT', { enabled },
    () => (enabled ? 'Employee self-service turned on.' : 'Employee self-service turned off.'), 'Could not change the setting - try again');

  const open = state?.platformEnabled && state.enabled;
  return (
    <div className="mt-4 border-t border-[var(--ff-border-primary)] pt-4" data-testid="employee-portal-card">
      <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Employee self-service</h3>
      {state && !state.platformEnabled && (
        <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">Not available for this company yet. IsaFlow turns it on.</p>
      )}
      {state?.platformEnabled && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[var(--ff-text-secondary)]">
          <span>{state.enabled ? 'On for this company.' : 'Off for this company.'}</span>
          {canEdit && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void toggle(!state.enabled)}>{state.enabled ? 'Turn off' : 'Turn on'}</Button>}
        </div>
      )}
      {access && (
        <div className="mt-2 space-y-1 text-sm text-[var(--ff-text-secondary)]">
          <p>This employee: <span className="font-medium text-[var(--ff-text-primary)]">{STATUS[access.status]}</span>
            {access.status === 'invited' && access.inviteExpiresAt ? ` (link valid to ${day(access.inviteExpiresAt)})` : ''}
            {access.status === 'active' && access.lastLoginAt ? ` (last signed in ${day(access.lastLoginAt)})` : ''}</p>
          {access.accessEnds && access.accessEnds !== 'closed' && <p>As a leaver, access ends after {access.accessEnds}.</p>}
          {access.accessEnds === 'closed' && <p>Not active: cannot use the portal.</p>}
        </div>
      )}
      {canEdit && access && (
        <div className="mt-3 flex flex-wrap gap-2">
          {open && access.status !== 'active' && (
            <Button size="sm" disabled={busy} onClick={() => void invite()}>{access.status === 'none' ? 'Invite to portal' : 'Invite again'}</Button>
          )}
          {(access.status === 'active' || access.status === 'invited') && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void revoke()}>End access</Button>
          )}
        </div>
      )}
      {message && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
