/**
 * Employee bank details on the profile (K2). Always the masked view (GET ?view=masked): a full read is audited, and
 * the card never needs one. Owner / admin change existing details; a manager makes a first entry (the server refuses it
 * for an employee who has been paid, and says so); everyone else sees the masks. Who changed it last comes from the
 * entity history.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Landmark, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { EntityHistoryTimeline } from '@/components/accounting/entity-history/EntityHistoryTimeline';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import type { EmployeeBankDetails } from '@/modules/accounting/services/payroll/payrollBankDetailsService';
import { ACCOUNT_TYPES, maskedNumber } from './employeeCreate/bankDetails';
import { BankDetailsEditor } from './BankDetailsEditor';
import { BankLastChange } from './BankLastChange';

const LOAD_FAILED = 'Could not load the bank details - try again';
const BUTTON = 'rounded-lg border border-[var(--ff-border-primary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]';

export function EmployeeBankCard({ employeeId }: { employeeId: string }) {
  const { companyRole } = useCompany();
  const admin = isHistoryAdmin(companyRole ?? undefined);
  const mayWrite = canWrite(companyRole); // owner / admin / manager: who may enter, and who the history route lets read
  const [details, setDetails] = useState<EmployeeBankDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const currentEmployee = useRef(employeeId);

  const load = useCallback(async (isStale: () => boolean = () => false) => {
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/bank-details?view=masked`);
      await assertOk(res, LOAD_FAILED);
      const json = (await res.json()) as { data?: EmployeeBankDetails | null };
      if (isStale()) return;
      setDetails(json.data ?? null);
      setError('');
    } catch (err) {
      if (isStale()) return;
      setDetails(null);
      setError(apiErrorMessage(err, LOAD_FAILED));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    currentEmployee.current = employeeId;
    let stale = false;
    setLoading(true);
    setEditing(false);
    void load(() => stale);
    return () => { stale = true; };
  }, [load]);

  // The reload after a save is for the employee that was saved: if the page has moved on, it must not land.
  const saved = () => {
    const savedFor = employeeId;
    setEditing(false); setLoading(true);
    void load(() => currentEmployee.current !== savedFor);
  };
  const typeLabel = ACCOUNT_TYPES.find(t => t.value === details?.accountType)?.label ?? details?.accountType;
  const rows: Array<[string, string]> = details ? [
    ['Bank', details.bankName], ['Account number', maskedNumber(details.accountNumber)], ['Branch code', details.branchCode],
    ['Account type', typeLabel ?? ''], ['Account holder', details.accountHolder ?? '—'],
  ] : [];

  return (
    <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5" data-testid="employee-bank-card">
      <div className="mb-4 flex items-center gap-2">
        <Landmark className="h-5 w-5 text-teal-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Bank details</h3>
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {loading && !error && <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-secondary)]" aria-label="Loading" />}
      {!loading && !error && editing && (
        <BankDetailsEditor employeeId={employeeId} onSaved={saved} onCancel={() => setEditing(false)}
          holderRequired={Boolean(details?.accountHolder)}
          start={details ? { bankName: details.bankName, accountType: details.accountType } : undefined} />
      )}
      {!loading && !error && !editing && !details && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--ff-text-secondary)]">No bank details yet.</p>
          {mayWrite && <button type="button" className={BUTTON} onClick={() => setEditing(true)}>Add bank details</button>}
        </div>
      )}
      {!loading && !error && !editing && details && (
        <div className="space-y-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-[var(--ff-text-secondary)]">{label}</dt>
                <dd className="text-[var(--ff-text-primary)]">{value}</dd>
              </div>
            ))}
          </dl>
          {mayWrite && <BankLastChange key={details.id} employeeId={employeeId} />}
          {mayWrite && (
            <section aria-label="Bank details history" data-testid="bank-history" className="border-t border-[var(--ff-border-primary)] pt-3">
              <EntityHistoryTimeline key={details.id} entityType="payroll_bank_detail" employeeId={employeeId} allowReveal={false} />
            </section>
          )}
          {admin
            ? <button type="button" className={BUTTON} onClick={() => setEditing(true)}>Change bank details</button>
            : <p className="text-xs text-[var(--ff-text-secondary)]">Only an owner or admin can change existing bank details.</p>}
        </div>
      )}
    </section>
  );
}
