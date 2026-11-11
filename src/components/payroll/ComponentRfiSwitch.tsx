/**
 * The pay components list's "Counts as retirement-funding income" cell (wave 5 RF): a switch for an earning, for the roles
 * that may write payroll (PATCH /api/payroll/components/:id); Y / N for the others; a dash where it cannot apply (a deduction,
 * or an employer's own fund contribution). A run calculated before a switch must be recalculated before it is approved.
 */
import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';

interface Props {
  component: { id: string; name: string; componentType: string; countsAsRfi?: boolean };
  /** An employer fund contribution (3817 / 3825 / 3828): never part of RFI. */
  employerFund: boolean;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}

export function ComponentRfiSwitch({ component, employerFund, onChanged, onError }: Props) {
  const { companyRole } = useCompany();
  const [saving, setSaving] = useState(false);
  const on = component.countsAsRfi === true;
  if (component.componentType !== 'earning' || employerFund) return <span aria-label="Not applicable">—</span>;
  if (!canWrite(companyRole)) return <span>{on ? 'Y' : 'N'}</span>;

  const toggle = async (next: boolean) => {
    setSaving(true);
    onError('');
    try {
      const res = await apiFetch(`/api/payroll/components/${component.id}`, { method: 'PATCH', body: JSON.stringify({ countsAsRfi: next }) });
      await assertOk(res, 'Could not change the component - try again');
      await onChanged();
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not change the component - try again'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <input type="checkbox" checked={on} disabled={saving} onChange={(e) => void toggle(e.target.checked)}
      aria-label={`${component.name} counts as retirement-funding income`}
      title="Recalculate any pay run already calculated after changing this." />
  );
}
