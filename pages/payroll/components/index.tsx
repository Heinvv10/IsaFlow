/**
 * Pay Components List + Create — Phase 2.
 * Route: /payroll/components
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { Tags, Loader2, Plus } from 'lucide-react';
import { WriteOnly } from '@/components/payroll/WriteOnly';

type ComponentType = 'earning' | 'deduction' | 'employer_contribution';

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: ComponentType;
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
  paidOutsidePayroll?: boolean;
}

/** Only a retirement fund contribution can be paid outside payroll (PAYE 4c; the route and a CHECK refuse the rest). */
const RETIREMENT_CODES = new Set(['4001', '4003', '4006']);

const SARS_HINTS = [
  '3601 — Basic salary',
  '3605 — Annual bonus',
  '3606 — Commission',
  '3713 — Travel/cell allowance',
  '3802 — Housing allowance',
  '4001 — Pension fund (deduction)',
  '4003 — Provident fund (deduction)',
  '4006 — Retirement annuity (deduction)',
  '4005 — Medical aid (deduction)',
];

export default function PayComponentsPage() {
  const [components, setComponents] = useState<Component[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [sarsCode, setSarsCode] = useState('3601');
  const [type, setType] = useState<ComponentType>('earning');
  const [isTaxable, setIsTaxable] = useState(true);
  const [isUifApplicable, setIsUifApplicable] = useState(true);
  const [isSdlApplicable, setIsSdlApplicable] = useState(true);
  const [paidOutsidePayroll, setPaidOutsidePayroll] = useState(false);
  const canBePaidOutside = type === 'deduction' && RETIREMENT_CODES.has(sarsCode.trim());
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/components');
      await assertOk(res, 'Could not load the components - try again');
      const json = await res.json();
      setComponents((json.data ?? json) as Component[]);
    } catch (err) {
      setComponents([]);
      setError(apiErrorMessage(err, 'Could not load the components - try again'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name || !sarsCode) return;
    setCreating(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/components', {
        method: 'POST',
        body: JSON.stringify({
          name, sarsSourceCode: sarsCode, componentType: type,
          isTaxable, isUifApplicable, isSdlApplicable,
          paidOutsidePayroll: canBePaidOutside && paidOutsidePayroll,
        }),
      });
      await assertOk(res, 'Could not create the component - try again');
      setName(''); setSarsCode('3601'); setType('earning');
      setIsTaxable(true); setIsUifApplicable(true); setIsSdlApplicable(true); setPaidOutsidePayroll(false);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the component - try again'));
    } finally {
      setCreating(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Tags className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Pay Components</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Earnings and deductions (SARS-tagged)</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}

          <WriteOnly>
            <form onSubmit={create} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">New component</h2>
              <div className="grid grid-cols-4 gap-4">
                <div className="col-span-2">
                  <label className={label}>Name</label>
                  <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Basic Salary" />
                </div>
                <div>
                  <label className={label}>SARS code</label>
                  <input className={field} value={sarsCode} onChange={e => setSarsCode(e.target.value)} />
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{SARS_HINTS.join(' · ')}</p>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    Medical aid: deduct the full scheme contribution under 4005 (it decides the IRP5 4005/4116 and the 65+ credit);
                    an employer share is a separate taxable earning.
                  </p>
                </div>
                <div>
                  <label className={label}>Type</label>
                  <select className={field} value={type} onChange={e => setType(e.target.value as ComponentType)}>
                    <option value="earning">Earning</option>
                    <option value="deduction">Deduction</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                  <input type="checkbox" checked={isTaxable} onChange={e => setIsTaxable(e.target.checked)} />
                  Taxable
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                  <input type="checkbox" checked={isUifApplicable} onChange={e => setIsUifApplicable(e.target.checked)} />
                  UIF applicable
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                  <input type="checkbox" checked={isSdlApplicable} onChange={e => setIsSdlApplicable(e.target.checked)} />
                  SDL applicable
                </label>
                {canBePaidOutside && (
                  <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]"
                    title="The employee pays the fund directly (e.g. a private retirement annuity): it reduces PAYE and is on the IRP5, but is not deducted from pay.">
                    <input type="checkbox" checked={paidOutsidePayroll} onChange={e => setPaidOutsidePayroll(e.target.checked)} />
                    Paid outside payroll
                  </label>
                )}
                <button type="submit" disabled={creating || !name}
                  className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add component
                </button>
              </div>
            </form>
          </WriteOnly>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : components.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)] text-sm">
              No components yet — create one above.
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SARS</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Tax</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SDL</th>
                  </tr>
                </thead>
                <tbody>
                  {components.map(c => (
                    <tr key={c.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{c.name}</td>
                      <td className="py-3 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{c.sarsSourceCode}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                        <span className="capitalize">{c.componentType.replace('_', ' ')}</span>
                        {c.paidOutsidePayroll && <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">paid outside payroll</span>}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isTaxable ? 'Y' : 'N'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isUifApplicable ? 'Y' : 'N'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isSdlApplicable ? 'Y' : 'N'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
