/**
 * The assumptions' lists (budgets P6 spec §4): capex, existing loans (include or not; schedules are the server's),
 * planned loans, share issues and dividends. One small table editor drives them all; money is entered in rands
 * and stored in cents, months as 'YYYY-MM'. A list replaces whole in a scenario's overrides (`buildSaveDoc`).
 */
import { Plus, Trash2 } from 'lucide-react';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { INPUT, NumberInput } from './AssumptionFields';
import { newId } from './assumptionsModel';
import type { LoanOption } from './threeWayClient';

type Doc = ThreeWayAssumptions;
type Row = Record<string, unknown> & { id: string };
type ColKind = 'month' | 'money' | 'text' | 'number' | 'bool';
interface Col { key: string; label: string; kind: ColKind }

const BTN = 'inline-flex items-center gap-1 rounded-md border border-[var(--ff-border-light)] px-2 py-1 text-xs text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';

function Cell({ col, row, label, readOnly, onSet }: { col: Col; row: Row; label: string; readOnly: boolean; onSet: (v: unknown) => void }) {
  const v = row[col.key];
  if (col.kind === 'bool') {
    return <input type="checkbox" aria-label={label} disabled={readOnly} checked={v === true} onChange={(e) => onSet(e.target.checked)} />;
  }
  if (col.kind === 'money' || col.kind === 'number') {
    const shown = v === undefined ? '' : String(col.kind === 'money' ? Number(v) / 100 : v);
    return (
      <NumberInput label={label} disabled={readOnly} value={shown} min={0} onValue={(raw) => {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) return;
        onSet(col.kind === 'money' ? Math.round(n * 100) : n);
      }} />
    );
  }
  return (
    <input aria-label={label} className={INPUT} type={col.kind === 'month' ? 'month' : 'text'} disabled={readOnly}
      value={String(v ?? '')} maxLength={200} onChange={(e) => onSet(e.target.value)} />
  );
}

function ListEditor({ title, cols, rows, readOnly, onChange, blank, testId }: {
  title: string; cols: Col[]; rows: Row[]; readOnly: boolean; onChange: (rows: Row[]) => void; blank: () => Row; testId: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</h4>
        {!readOnly && <button type="button" className={BTN} onClick={() => onChange([...rows, blank()])}><Plus className="h-3 w-3" aria-hidden="true" />Add</button>}
      </div>
      {rows.length === 0 ? <p className="text-xs text-[var(--ff-text-secondary)]">None.</p> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-xs text-[var(--ff-text-tertiary)]">
              {cols.map((c) => <th key={c.key} className="px-1 py-1 font-medium">{c.label}</th>)}<th className="w-8" />
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  {cols.map((c) => (
                    <td key={c.key} className="px-1 py-1 align-top">
                      <Cell col={c} row={r} label={`${title} ${i + 1} ${c.label}`} readOnly={readOnly}
                        onSet={(v) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: v } : x)))} />
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    {!readOnly && (
                      <button type="button" aria-label={`Remove ${title} ${i + 1}`} className={BTN} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export interface AssumptionListsProps {
  doc: Doc;
  firstMonth: string;
  loans: readonly LoanOption[];
  readOnly: boolean;
  onChange: (next: (d: Doc) => Doc) => void;
}

export function AssumptionLists({ doc, firstMonth, loans, readOnly, onChange }: AssumptionListsProps) {
  const setCapex = (rows: Row[]) => onChange((d) => ({ ...d, capex: rows as unknown as Doc['capex'] }));
  const existingIds = new Set(doc.loans.existing.map((l) => l.loanId));
  const addable = loans.filter((l) => !existingIds.has(l.id));
  const loanLabel = (id: string) => loans.find((l) => l.id === id)?.label ?? id;
  return (
    <div className="space-y-5">
      <ListEditor title="Capex" testId="tw-capex" readOnly={readOnly} rows={doc.capex as unknown as Row[]} onChange={setCapex}
        blank={() => ({ id: newId('capex'), month: firstMonth, amountExVat: 0, vatClaimable: true, description: '' })}
        cols={[{ key: 'description', label: 'Description', kind: 'text' }, { key: 'month', label: 'Month paid', kind: 'month' },
          { key: 'amountExVat', label: 'Amount ex VAT (R)', kind: 'money' }, { key: 'vatClaimable', label: 'VAT claimable', kind: 'bool' }]} />

      <div className="space-y-2" data-testid="tw-loans-existing">
        <h4 className="text-sm font-medium text-[var(--ff-text-primary)]">Existing loans</h4>
        {doc.loans.existing.length === 0 && <p className="text-xs text-[var(--ff-text-secondary)]">None included.</p>}
        {doc.loans.existing.map((l, i) => (
          <label key={l.loanId} className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
            <input type="checkbox" disabled={readOnly} checked={l.include}
              onChange={(e) => onChange((d) => ({ ...d, loans: { ...d.loans, existing: d.loans.existing.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)) } }))} />
            {loanLabel(l.loanId)} (repayments from its schedule)
          </label>
        ))}
        {!readOnly && addable.length > 0 && (
          <select aria-label="Include an existing loan" className={`${INPUT} max-w-xs`} value=""
            onChange={(e) => { const id = e.target.value; if (id) onChange((d) => ({ ...d, loans: { ...d.loans, existing: [...d.loans.existing, { loanId: id, include: true }] } })); }}>
            <option value="">Include an existing loan…</option>
            {addable.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        )}
      </div>

      <ListEditor title="Planned loans" testId="tw-loans-planned" readOnly={readOnly} rows={doc.loans.planned as unknown as Row[]}
        onChange={(rows) => onChange((d) => ({ ...d, loans: { ...d.loans, planned: rows as unknown as Doc['loans']['planned'] } }))}
        blank={() => ({ id: newId('loan'), description: '', drawdownMonth: firstMonth, principal: 100, annualRatePct: 0, termMonths: 12, firstRepaymentMonth: firstMonth })}
        cols={[{ key: 'description', label: 'Description', kind: 'text' }, { key: 'drawdownMonth', label: 'Drawn', kind: 'month' },
          { key: 'principal', label: 'Principal (R)', kind: 'money' }, { key: 'annualRatePct', label: 'Rate % a year', kind: 'number' },
          { key: 'termMonths', label: 'Term (months)', kind: 'number' }, { key: 'firstRepaymentMonth', label: 'First repayment', kind: 'month' }]} />

      <ListEditor title="Share issues" testId="tw-share-issues" readOnly={readOnly} rows={doc.equity.shareIssues as unknown as Row[]}
        onChange={(rows) => onChange((d) => ({ ...d, equity: { ...d.equity, shareIssues: rows as unknown as Doc['equity']['shareIssues'] } }))}
        blank={() => ({ id: newId('shares'), month: firstMonth, amount: 100 })}
        cols={[{ key: 'month', label: 'Month', kind: 'month' }, { key: 'amount', label: 'Amount (R)', kind: 'money' }]} />

      <ListEditor title="Dividends" testId="tw-dividends" readOnly={readOnly} rows={doc.equity.dividends as unknown as Row[]}
        onChange={(rows) => onChange((d) => ({ ...d, equity: { ...d.equity, dividends: rows as unknown as Doc['equity']['dividends'] } }))}
        blank={() => ({ id: newId('dividend'), declaredMonth: firstMonth, paidMonth: firstMonth, amount: 100 })}
        cols={[{ key: 'declaredMonth', label: 'Declared', kind: 'month' }, { key: 'paidMonth', label: 'Paid', kind: 'month' },
          { key: 'amount', label: 'Amount (R)', kind: 'money' }]} />
    </div>
  );
}
