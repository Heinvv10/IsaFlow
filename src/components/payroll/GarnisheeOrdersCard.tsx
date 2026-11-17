/**
 * GarnisheeOrdersCard - the employee's garnishee (court) orders (wave 6 GA): list, enter, end. Payroll-detail roles only
 * (the route refuses the rest, and refuses a Login-as session). The run deducts each active order from net pay after
 * tax; emoluments attachment orders together stop at 25% of basic salary (Magistrates' Courts Act s65J(1A)(a)) and
 * maintenance orders are outside that limit and taken first (Maintenance Act s28, s29(3)). The balance moves only when
 * a run that deducted is approved. Paying the creditor is not done here.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Gavel, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DateField, Input, MoneyField, Select } from '@/components/ui';
import { todayInSast } from '@/lib/saDateParser';
import { formatCurrency } from '@/utils/formatters';
import type { GarnisheeKind } from '@/modules/accounting/services/payroll/payrollGarnishee';
import type { GarnisheeOrder } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';

const FAILED = 'Could not load the garnishee orders - try again';
const KIND_LABEL: Record<GarnisheeKind, string> = {
  emolument_attachment: 'Emoluments attachment (s65J)', maintenance: 'Maintenance order', administration: 'Administration order',
};
const STATUS_LABEL: Record<GarnisheeOrder['status'], string> = { active: 'Active', ended: 'Ended', satisfied: 'Paid off' };
const BTN = 'rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50';

interface Draft {
  kind: GarnisheeKind;
  reference: string;
  creditorName: string;
  instalmentCents: number | null;
  totalDebtCents: number | null;
  startDate: string | null;
  endDate: string | null;
  priority: string;
}
const EMPTY: Draft = {
  kind: 'emolument_attachment', reference: '', creditorName: '', instalmentCents: null, totalDebtCents: null,
  startDate: todayInSast(), endDate: null, priority: '100',
};

export function GarnisheeOrdersCard({ employeeId }: { employeeId: string }) {
  const url = `/api/payroll/employees/${employeeId}/garnishee-orders`;
  const [orders, setOrders] = useState<GarnisheeOrder[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [resetKey, setResetKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState<{ id: string; date: string | null; reason: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await apiFetch(url);
      await assertOk(res, FAILED);
      setOrders(((await res.json()) as { data?: { orders?: GarnisheeOrder[] } }).data?.orders ?? []);
    } catch (err) {
      setOrders([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [url]);
  useEffect(() => { void load(); }, [load]);

  async function send(target: string, body: unknown, failed: string): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    if (!draft.reference.trim() || !draft.creditorName.trim()) { setError('Enter the court or case reference and the creditor'); return; }
    if (!draft.instalmentCents || draft.instalmentCents <= 0) { setError('Enter the monthly instalment the order states'); return; }
    if (!draft.startDate) { setError('Enter the date the order starts'); return; }
    const ok = await send(url, {
      kind: draft.kind, reference: draft.reference, creditorName: draft.creditorName, instalment: draft.instalmentCents / 100,
      totalDebt: draft.totalDebtCents ? draft.totalDebtCents / 100 : null, startDate: draft.startDate, endDate: draft.endDate,
      priority: Number(draft.priority),
    }, 'Could not save the garnishee order - try again');
    if (ok) { setDraft({ ...EMPTY, startDate: todayInSast() }); setResetKey((k) => k + 1); }
  }

  async function end(): Promise<void> {
    if (!ending?.date) return;
    const ok = await send(`${url}/${ending.id}`, { endDate: ending.date, reason: ending.reason }, 'Could not end the garnishee order - try again');
    if (ok) setEnding(null);
  }

  return (
    <section aria-labelledby="employee-garnishee-heading"
      className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <Gavel className="h-5 w-5 text-[var(--ff-text-secondary)]" aria-hidden="true" />
        <h3 id="employee-garnishee-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Garnishee orders</h3>
      </div>
      {orders === null ? (
        <p className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading garnishee orders…
        </p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">No garnishee orders recorded.</p>
      ) : (
        <ul className="divide-y divide-[var(--ff-border-primary)] text-sm">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <span className="min-w-0 text-[var(--ff-text-primary)]">
                <span className="font-medium">{KIND_LABEL[o.kind]}</span> {o.reference}: {formatCurrency(o.instalment)} a month to {o.creditorName}
                <span className="block text-xs text-[var(--ff-text-secondary)]">
                  {STATUS_LABEL[o.status]} · {o.startDate} to {o.endDate ?? 'open'} · priority {o.priority}
                  {o.totalDebt !== null && ` · owes ${formatCurrency(o.balance ?? 0)} of ${formatCurrency(o.totalDebt)}`}
                  {o.deducted > o.applied && ` · ${formatCurrency(o.deducted - o.applied)} on runs not yet approved`}
                </span>
              </span>
              {o.status !== 'ended' && (ending?.id === o.id ? (
                <span className="flex w-full flex-wrap items-end gap-2">
                  <DateField label="Ends on" value={ending.date} minDate={o.startDate} onChange={(iso) => setEnding({ ...ending, date: iso })} />
                  <Input label="Why it ends" value={ending.reason} onChange={(e) => setEnding({ ...ending, reason: e.target.value })} />
                  <button type="button" onClick={() => void end()} disabled={saving || !ending.date || ending.reason.trim().length < 5} className={BTN}>Confirm</button>
                  <button type="button" onClick={() => setEnding(null)} className="text-sm text-[var(--ff-text-secondary)] underline">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setEnding({ id: o.id, date: todayInSast(), reason: '' })}
                  className="text-sm text-brand-600 underline dark:text-brand-400">End</button>
              ))}
            </li>
          ))}
        </ul>
      )}
      <fieldset className="mt-4 grid grid-cols-1 gap-3 border-t border-[var(--ff-border-primary)] pt-4 md:grid-cols-2" disabled={saving}>
        <legend className="sr-only">Enter a garnishee order</legend>
        <Select id="garnishee-kind" label="Kind" value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: (v || 'emolument_attachment') as GarnisheeKind })}
          options={(Object.keys(KIND_LABEL) as GarnisheeKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        <Input label="Court or case reference" value={draft.reference} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />
        <Input label="Creditor" value={draft.creditorName} onChange={(e) => setDraft({ ...draft, creditorName: e.target.value })} />
        <MoneyField label="Monthly instalment" value={draft.instalmentCents} resetKey={resetKey}
          onChange={(cents) => setDraft({ ...draft, instalmentCents: cents })} />
        <MoneyField label="Total debt (blank if open-ended)" value={draft.totalDebtCents} resetKey={resetKey}
          onChange={(cents) => setDraft({ ...draft, totalDebtCents: cents })} />
        <Input label="Priority (1 is taken first)" inputMode="numeric" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} />
        <DateField label="Starts on" value={draft.startDate} resetKey={resetKey} onChange={(iso) => setDraft({ ...draft, startDate: iso })} />
        <DateField label="Ends on (optional)" value={draft.endDate} resetKey={resetKey} onChange={(iso) => setDraft({ ...draft, endDate: iso })} />
        <div className="md:col-span-2">
          <button type="button" onClick={() => void add()} disabled={saving} className={BTN}>{saving ? 'Saving…' : 'Add order'}</button>
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-[var(--ff-text-secondary)]">
        Deducted from net pay after tax. Emoluments attachment orders together stop at 25% of basic salary (Magistrates&apos; Courts Act
        s65J(1A)); maintenance orders are outside that limit and taken first. A shortfall is shown on the pay run and stays owed.
      </p>
      {error && (
        <p role="alert" className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />{error}
        </p>
      )}
    </section>
  );
}
