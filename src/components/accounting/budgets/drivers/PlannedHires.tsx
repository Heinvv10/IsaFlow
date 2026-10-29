/**
 * The version's planned hires, edited inline (P4 decision 7): a role label (never a person's
 * name), an optional cost centre, start and optional end month, FTE. Each row saves on its own
 * (POST a new hire, PUT an existing one, DELETE), through the workspace's driver write path, so
 * the token is sent and adopted and the grid reloads (per_head drivers move). A refusal stays on
 * the row with the server's message.
 */
import { useState } from 'react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { StoredPlannedHire } from './driverClient';
import type { ScopeOption } from './DriverKindFields';

export interface HireDraft { id?: string; label: string; costCentreId: string; startMonth: string; endMonth: string; fte: string }
export type HireInput = { id?: string; label: string; costCentreId: string | null; startMonth: string; endMonth: string | null; fte: number };

/** The hire the row describes, or what to fix (the server checks again). */
export function checkHire(d: HireDraft): { ok: true; hire: HireInput } | { ok: false; message: string } {
  const label = d.label.trim();
  if (label.length < 1 || label.length > 120) return { ok: false, message: 'Give the role a label of 1 to 120 characters (a role, never a name).' };
  const fte = Number(d.fte.replace(',', '.'));
  if (!/^\d+([.,]\d{1,2})?$/.test(d.fte.trim()) || !(fte > 0) || fte > 9999.99) return { ok: false, message: 'FTE is more than 0 with at most 2 decimals (1 = full time).' };
  if (d.endMonth !== '' && d.endMonth < d.startMonth) return { ok: false, message: 'The hire cannot end before it starts.' };
  return { ok: true, hire: { ...(d.id ? { id: d.id } : {}), label, costCentreId: d.costCentreId === '' ? null : d.costCentreId, startMonth: d.startMonth, endMonth: d.endMonth === '' ? null : d.endMonth, fte } };
}

const draftOf = (h: StoredPlannedHire): HireDraft =>
  ({ id: h.id, label: h.label, costCentreId: h.costCentreId ?? '', startMonth: h.startMonth, endMonth: h.endMonth ?? '', fte: String(h.fte) });

const CELL = 'rounded border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-2 py-1 text-xs text-[var(--ff-text-primary)] disabled:opacity-60';
const BTN = 'rounded border border-[var(--ff-border-light)] px-2 py-1 text-xs text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';

interface RowProps {
  initial: HireDraft;
  months: readonly string[];
  costCentres: readonly ScopeOption[];
  editable: boolean;
  onSave(h: HireInput): Promise<string | null>;
  onDelete: (() => Promise<string | null>) | null;
}

function HireRow({ initial, months, costCentres, editable, onSave, onDelete }: RowProps) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<HireDraft>) => { setD((x) => ({ ...x, ...p })); setError(null); };
  const name = d.label.trim() || 'new hire';
  const run = async (fn: () => Promise<string | null>) => { setBusy(true); const e = await fn(); setBusy(false); setError(e); };
  const save = () => {
    const c = checkHire(d);
    if (!c.ok) { setError(c.message); return; }
    void run(() => onSave(c.hire));
  };
  const off = !editable || busy;
  return (
    <li className="space-y-1 border-b border-[var(--ff-border-light)] py-2" data-testid="planned-hire">
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={`Role of ${name}`} placeholder="Role, e.g. Sales rep (never a person's name)" maxLength={120}
          className={`${CELL} min-w-[12rem] flex-1`} value={d.label} disabled={off} onChange={(e) => set({ label: e.target.value })} />
        <select aria-label={`Cost centre of ${name}`} className={CELL} value={d.costCentreId} disabled={off} onChange={(e) => set({ costCentreId: e.target.value })}>
          <option value="">No cost centre</option>
          {costCentres.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select aria-label={`Start month of ${name}`} className={CELL} value={d.startMonth} disabled={off} onChange={(e) => set({ startMonth: e.target.value })}>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <select aria-label={`End month of ${name}`} className={CELL} value={d.endMonth} disabled={off} onChange={(e) => set({ endMonth: e.target.value })}>
          <option value="">No end</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <input aria-label={`FTE of ${name}`} inputMode="decimal" className={`${CELL} w-16`} value={d.fte} disabled={off} onChange={(e) => set({ fte: e.target.value })} />
        {editable && (
          <>
            <button type="button" className={BTN} disabled={busy} onClick={save}>{d.id ? 'Save' : 'Add hire'}</button>
            {onDelete && <button type="button" className={BTN} disabled={busy} onClick={() => { void run(onDelete); }}>Delete</button>}
          </>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-error-700 dark:text-error-400">{error}</p>}
    </li>
  );
}

export interface PlannedHiresProps {
  hires: readonly StoredPlannedHire[];
  months: readonly string[];
  costCentres: readonly ScopeOption[];
  editable: boolean;
  onSave(h: HireInput): Promise<string | null>;
  onDelete(id: string): Promise<string | null>;
}

export function PlannedHires({ hires, months, costCentres, editable, onSave, onDelete }: PlannedHiresProps) {
  const blank: HireDraft = { label: '', costCentreId: '', startMonth: months[0] ?? '', endMonth: '', fte: '1' };
  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Planned hires</h3>
      <p className="text-xs text-[var(--ff-text-tertiary)]">Roles you plan to fill in this version. Label a role, never a person.</p>
      <ul>
        {hires.map((h) => (
          <HireRow key={`${h.id}:${h.updatedAt}`} initial={draftOf(h)} months={months} costCentres={costCentres} editable={editable}
            onSave={onSave} onDelete={() => onDelete(h.id)} />
        ))}
        {editable && <HireRow key={`new:${hires.length}`} initial={blank} months={months} costCentres={costCentres} editable onSave={onSave} onDelete={null} />}
      </ul>
      {hires.length === 0 && !editable && <p className="text-xs text-[var(--ff-text-tertiary)]">No planned hires.</p>}
    </div>
  );
}
