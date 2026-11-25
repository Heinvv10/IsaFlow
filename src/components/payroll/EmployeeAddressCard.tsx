/**
 * The employee's residential and postal address on the profile (wave 7 EA1, W5; Hein's ruling 10). Owner / admin /
 * manager capture and change it; the employee sees it read-only in the portal. Who changed it is in the page's
 * "Record changes" timeline (masked). The fields are the IRP5 / IT3(a) address codes e@syFile asks for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import {
  postalLines, residentialLines, type EmployeeAddress,
} from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';
import { EmployeeAddressEditor } from './EmployeeAddressEditor';

const LOAD_FAILED = 'Could not load the address - try again';
const BUTTON = 'rounded-lg border border-[var(--ff-border-primary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]';

export function AddressBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <dt className="text-xs text-[var(--ff-text-secondary)]">{title}</dt>
      <dd className="text-sm text-[var(--ff-text-primary)]">{lines.map((l, i) => <span key={i} className="block">{l}</span>)}</dd>
    </div>
  );
}

export function EmployeeAddressCard({ employeeId }: { employeeId: string }) {
  const { companyRole } = useCompany();
  const mayWrite = canWrite(companyRole);
  const [address, setAddress] = useState<EmployeeAddress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const current = useRef(employeeId);

  const load = useCallback(async (isStale: () => boolean = () => false) => {
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/address`);
      await assertOk(res, LOAD_FAILED);
      const json = (await res.json()) as { data?: EmployeeAddress | null };
      if (isStale()) return;
      // Anything but an address object is none: a malformed answer must not take the employee page down with it.
      const data = json.data as Partial<EmployeeAddress> | null | undefined;
      setAddress(data && typeof data === 'object' && data.residential && data.postal ? data as EmployeeAddress : null);
      setError('');
    } catch (err) {
      if (isStale()) return;
      setAddress(null);
      setError(apiErrorMessage(err, LOAD_FAILED));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    current.current = employeeId;
    let stale = false;
    setLoading(true);
    setEditing(false);
    void load(() => stale);
    return () => { stale = true; };
  }, [load]);

  const saved = () => {
    const savedFor = employeeId;
    setEditing(false); setLoading(true);
    void load(() => current.current !== savedFor);
  };

  return (
    <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5" data-testid="employee-address-card">
      <div className="mb-4 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-teal-500" aria-hidden="true" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Address</h3>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {loading && !error && <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-secondary)]" aria-label="Loading" />}
      {!loading && !error && editing && (
        <EmployeeAddressEditor employeeId={employeeId} start={address} onSaved={saved} onCancel={() => setEditing(false)} />
      )}
      {!loading && !error && !editing && (
        <div className="space-y-3">
          {address ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <AddressBlock title="Residential address" lines={residentialLines(address.residential)} />
              <AddressBlock title="Postal address" lines={address.postal.sameAsResidential ? ['Same as the residential address'] : postalLines(address)} />
            </dl>
          ) : (
            <p className="text-sm text-[var(--ff-text-secondary)]">No address yet. The IRP5 certificate needs the residential and postal address.</p>
          )}
          {mayWrite && (
            <button type="button" className={BUTTON} onClick={() => setEditing(true)}>{address ? 'Change address' : 'Add address'}</button>
          )}
        </div>
      )}
    </section>
  );
}
