/**
 * EmployeeFringeBenefitsCard - the employee's company vehicle and travel allowance inputs (wave 5 FB), which decide
 * how much of each is remuneration for PAYE: 80%, or 20% where the employer is satisfied at least 80% of the use is
 * business (PAYE-GEN-01-G21 (2027) p. 5). The vehicle benefit is 3.5% of the determined value a month, 3.25% with a
 * maintenance plan. Payroll-detail roles only (the route refuses the rest).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Car, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { DateField } from '@/components/ui';
import { todayInSast } from '@/lib/saDateParser';
import { formatCurrency } from '@/utils/formatters';
import { vehicleMonthlyBenefit, type FringeBenefit, type FringeKind } from '@/modules/accounting/services/payroll/fringeBenefits';

const FAILED = 'Could not load the fringe benefits - try again';
const KIND_LABEL: Record<FringeKind, string> = { company_vehicle: 'Company vehicle', travel_allowance: 'Travel allowance' };
const INPUT = 'w-full rounded-md border border-[var(--ff-border-primary)] bg-[var(--ff-surface-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]';
const BTN = 'rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';

function describe(b: FringeBenefit): string {
  const share = b.businessUseAtLeast80 ? '20%' : '80%';
  if (b.kind === 'travel_allowance') return `${share} of the allowance is taxed`;
  const monthly = vehicleMonthlyBenefit(b.determinedValue ?? 0, b.maintenancePlan);
  return `${formatCurrency(monthly)} a month (${b.maintenancePlan ? '3.25%' : '3.5%'} of ${formatCurrency(b.determinedValue ?? 0)}), ${share} taxed`;
}

export function EmployeeFringeBenefitsCard({ employeeId }: { employeeId: string }) {
  const [rows, setRows] = useState<FringeBenefit[] | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<FringeKind>('company_vehicle');
  const [value, setValue] = useState('');
  const [maintenance, setMaintenance] = useState(false);
  const [business, setBusiness] = useState(false);
  const [from, setFrom] = useState<string | null>(todayInSast());
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState<{ id: string; date: string | null } | null>(null);
  const url = `/api/payroll/employees/${employeeId}/fringe-benefits`;

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(await apiJson(`/api/payroll/employees/${employeeId}/fringe-benefits`, undefined, FAILED));
    } catch (err) {
      setRows([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [employeeId]);
  useEffect(() => { void load(); }, [load]);

  async function send(method: 'POST' | 'PATCH', body: unknown, failed: string): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await assertOk(res, failed);
      await load();
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, failed));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(): Promise<void> {
    const vehicle = kind === 'company_vehicle';
    const amount = Number(value);
    if (vehicle && !(amount > 0)) { setError('Enter the vehicle\'s determined value'); return; }
    const ok = await send('POST', {
      kind, determinedValue: vehicle ? amount : null, maintenancePlan: vehicle && maintenance,
      businessUseAtLeast80: business, effectiveFrom: from ?? '',
    }, 'Could not save the fringe benefit - try again');
    if (ok) { setValue(''); setMaintenance(false); setBusiness(false); }
  }

  async function end(): Promise<void> {
    if (!ending?.date) return;
    if (await send('PATCH', { benefitId: ending.id, effectiveTo: ending.date }, 'Could not end the fringe benefit - try again')) setEnding(null);
  }

  return (
    <section aria-labelledby="employee-fringe-heading"
      className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <Car className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <h3 id="employee-fringe-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Fringe benefits</h3>
      </div>
      {rows === null ? (
        <p className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading fringe benefits…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">No company vehicle or travel allowance recorded.</p>
      ) : (
        <ul className="divide-y divide-[var(--ff-border-primary)] text-sm">
          {rows.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-[var(--ff-text-primary)]">
                <span className="font-medium">{KIND_LABEL[b.kind]}</span>: {describe(b)}
                <span className="block text-xs text-[var(--ff-text-secondary)]">{b.effectiveFrom} to {b.effectiveTo ?? 'open'}</span>
              </span>
              {b.effectiveTo === null && (ending?.id === b.id ? (
                <span className="flex items-center gap-2">
                  <DateField label="End date" value={ending.date} onChange={(iso) => setEnding({ id: b.id, date: iso })} />
                  <button type="button" onClick={() => void end()} disabled={saving || !ending.date || ending.date < b.effectiveFrom} className={BTN}>Confirm</button>
                  <button type="button" onClick={() => setEnding(null)} className="text-sm text-[var(--ff-text-secondary)] underline">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setEnding({ id: b.id, date: todayInSast() })}
                  className="text-sm text-brand-600 underline dark:text-brand-400">End</button>
              ))}
            </li>
          ))}
        </ul>
      )}
      <fieldset className="mt-4 space-y-3 border-t border-[var(--ff-border-primary)] pt-4" disabled={saving}>
        <legend className="sr-only">Add a fringe benefit</legend>
        <div role="radiogroup" aria-label="Benefit" className="flex gap-2">
          {(Object.keys(KIND_LABEL) as FringeKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={`rounded-lg border px-3 py-2 text-sm ${kind === k ? 'border-brand-600 bg-brand-600/10 font-medium' : 'border-[var(--ff-border-primary)]'} text-[var(--ff-text-primary)]`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {kind === 'company_vehicle' && (
          <>
            <label className="block text-sm text-[var(--ff-text-secondary)]">Determined value (R)
              <input type="number" min="0" step="0.01" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={`${INPUT} mt-1`} />
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
              <input type="checkbox" checked={maintenance} onChange={(e) => setMaintenance(e.target.checked)} />
              Maintenance plan included in the purchase price (3.25% instead of 3.5%)
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
          Employer is satisfied at least 80% of the use is business (PAYE on 20%, not 80%)
        </label>
        <DateField label="From" value={from} onChange={(iso) => setFrom(iso)} />
        <button type="button" onClick={() => void add()} disabled={saving || !from} className={BTN}>{saving ? 'Saving…' : 'Add'}</button>
      </fieldset>
      <p className="mt-3 text-xs text-[var(--ff-text-secondary)]">
        A travel allowance is the pay component coded 3701; this sets how much of it PAYE takes. A vehicle needs an active taxable earning coded 3802.
      </p>
      {error && (
        <p role="alert" className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />{error}
        </p>
      )}
    </section>
  );
}
