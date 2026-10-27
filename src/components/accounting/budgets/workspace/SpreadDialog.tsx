/**
 * Row-action dialogs that need input (spec §4.4, §6.5): spread a row across its months (even,
 * PY seasonality, step growth), spread a header's amount across its sub-accounts (evenly or by
 * PY, a month or the FY), and move a legacy header's own amounts to one sub-account. Each shows
 * a preview and hands the grid ONE write list (one undo entry). The maths is `spread.ts`.
 */
import { useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MoneyField } from '@/components/ui/MoneyField';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { residueFlipsSign, spreadEven, spreadSeasonal, spreadStep, type SpreadResult } from '@/modules/accounting/services/budgets/grid/spread';
import { fig } from './BudgetSubtotalRow';
import {
  type CellWriteByKey, type ChildShare, childWrites, clearWrites, moveWrites, rowWrites, splitAcrossChildren,
} from './rowActionWrites';

export interface RowCells { keys: readonly CellKey[]; values: readonly (number | null)[] }
export type NamedChild = ChildShare & { label: string };

export type SpreadTarget =
  | { mode: 'row'; label: string; row: RowCells; py: readonly number[] | null }
  | { mode: 'children'; label: string; children: readonly NamedChild[]; own: RowCells | null }
  | { mode: 'move'; label: string; children: readonly NamedChild[]; own: RowCells };

/** Mount it per target (`key`), so its fields start from that row. */
interface SpreadDialogProps {
  target: SpreadTarget;
  months: readonly string[];
  unit: RoundingUnit;
  onApply(writes: CellWriteByKey[], announcement: string): void;
  onClose(): void;
}

type Method = 'even' | 'seasonal' | 'step' | 'py';
type Preview = { ok: true; lines: { label: string; cents: number }[]; writes: CellWriteByKey[]; note: string | null } | { ok: false; reason: string };

const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

function Choice({ value, current, onPick, children }: { value: Method; current: Method; onPick(m: Method): void; children: string }) {
  return (
    <Button type="button" size="sm" variant={value === current ? 'primary' : 'secondary'} aria-pressed={value === current} onClick={() => onPick(value)}>
      {children}
    </Button>
  );
}

function preview(target: SpreadTarget, months: readonly string[], unit: RoundingUnit, method: Method, amount: number | null,
  growth: number, month: number | null, childId: string | null): Preview {
  if (target.mode === 'move') {
    const child = target.children.find(c => c.accountId === childId);
    if (!child) return { ok: false, reason: 'Pick the sub-account that takes the amounts.' };
    const writes = moveWrites(target.own.keys, target.own.values, child.keys, child.values);
    return { ok: true, writes, note: null, lines: [{ label: child.label, cents: sum(child.values) + sum(target.own.values) }] };
  }
  if (amount === null) return { ok: false, reason: 'Enter an amount.' };
  if (target.mode === 'row') {
    const n = months.length;
    const r: SpreadResult = method === 'seasonal'
      ? (target.py ? spreadSeasonal(amount, target.py, unit) : { ok: false, reason: 'Prior-year actuals are not loaded.' })
      : method === 'step' ? spreadStep(amount, n, growth, unit) : spreadEven(amount, n, unit);
    if (!r.ok) return r;
    const note = residueFlipsSign(amount, r.months)
      ? `The R${unit} rounding puts the last month on the other side of zero; a smaller rounding unit avoids it.`
      : null;
    return { ok: true, note, writes: rowWrites(target.row.keys, r.months), lines: r.months.map((c, i) => ({ label: monthLabel(months[i] ?? ''), cents: c })) };
  }
  const split = splitAcrossChildren(amount, target.children, method === 'py' ? 'py' : 'even', month, months.length, unit);
  if (!split.ok) return split;
  const writes = childWrites(target.children, split.perChild, month);
  if (target.own) writes.push(...clearWrites(target.own.keys, target.own.values));
  const lines = target.children.map((c, i) => ({ label: c.label, cents: month === null ? sum(split.perChild[i] ?? []) : split.perChild[i]?.[month] ?? 0 }));
  return { ok: true, writes, lines, note: split.note };
}

const TITLE = { row: 'Spread across months', children: 'Spread across sub-accounts', move: 'Move to a sub-account' } as const;

export function SpreadDialog({ target, months, unit, onApply, onClose }: SpreadDialogProps) {
  const initial = target.mode === 'row' ? sum(target.row.values) : target.own ? sum(target.own.values) : null;
  const [amount, setAmount] = useState<number | null>(initial);
  const [method, setMethod] = useState<Method>('even');
  const [growth, setGrowth] = useState('2');
  const [month, setMonth] = useState<number | null>(null);
  const [childId, setChildId] = useState<string | null>(target.mode !== 'row' ? target.children[0]?.accountId ?? null : null);
  const growthPct = Number(growth.replace(',', '.'));
  const refusalRef = useRef<HTMLParagraphElement>(null);

  const result = useMemo(
    () => preview(target, months, unit, method, amount, growthPct, month, childId),
    [target, months, unit, method, amount, growthPct, month, childId],
  );

  // Apply is disabled while the preview refuses; should it fire anyway, focus the refusal so it is read out.
  const apply = () => {
    if (result.ok) onApply(result.writes, `${TITLE[target.mode]}: ${target.label}, ${result.writes.length} cells changed`);
    else refusalRef.current?.focus();
  };

  return (
    <Modal open onClose={onClose} title={`${TITLE[target.mode]}: ${target.label}`} size="md">
      <Modal.Body className="space-y-4">
        {target.mode === 'move' ? (
          <label className="block text-sm text-[var(--ff-text-secondary)]">
            Sub-account
            <select value={childId ?? ''} onChange={e => setChildId(e.target.value)}
              className="mt-1 block w-full rounded border border-[var(--ff-border-secondary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-2 py-1.5">
              {target.children.map(c => <option key={c.accountId} value={c.accountId}>{c.label}</option>)}
            </select>
          </label>
        ) : (
          <>
            <MoneyField label={target.mode === 'row' ? 'Full-year amount' : 'Amount to spread'} value={amount} onChange={setAmount} allowNegative />
            <div role="group" aria-label="Method" className="flex flex-wrap gap-2">
              <Choice value="even" current={method} onPick={setMethod}>Evenly</Choice>
              {target.mode === 'row' ? (
                <>
                  <Choice value="seasonal" current={method} onPick={setMethod}>PY seasonality</Choice>
                  <Choice value="step" current={method} onPick={setMethod}>Step growth</Choice>
                </>
              ) : <Choice value="py" current={method} onPick={setMethod}>In proportion to PY actuals</Choice>}
            </div>
            {target.mode === 'row' && method === 'step' && (
              <Input label="Monthly growth %" inputMode="decimal" value={growth} onChange={e => setGrowth(e.target.value)} />
            )}
            {target.mode === 'children' && (
              <label className="block text-sm text-[var(--ff-text-secondary)]">
                Period
                <select value={month === null ? 'fy' : String(month)} onChange={e => setMonth(e.target.value === 'fy' ? null : Number(e.target.value))}
                  className="mt-1 block w-full rounded border border-[var(--ff-border-secondary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-2 py-1.5">
                  <option value="fy">Full year (spread evenly over the months)</option>
                  {months.map((m, i) => <option key={m} value={i}>{monthLabel(m)}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <div aria-live="polite">
          {result.ok ? (
            <>
              {result.note && <p className="text-xs text-[var(--ff-text-tertiary)] mb-2">{result.note}</p>}
              {target.mode !== 'row' && target.own && (
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-2">The header&apos;s own amounts are cleared in the same change.</p>
              )}
              <table className="w-full text-sm" aria-label="Preview">
                <tbody>
                  {result.lines.map(l => (
                    <tr key={l.label} className="border-b border-[var(--ff-border-light)]">
                      <td className="py-1 text-[var(--ff-text-secondary)]">{l.label}</td>
                      <td className="py-1 text-right tabular-nums text-[var(--ff-text-primary)]">{fig(l.cents, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <p ref={refusalRef} tabIndex={-1} role="alert" className="text-sm text-[var(--ff-unfav)]">{result.reason}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={apply} disabled={!result.ok}>Apply</Button>
      </Modal.Footer>
    </Modal>
  );
}
