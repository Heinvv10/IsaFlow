/**
 * PayRunReviewGrid — a draft or calculated run's lines with editable once-off columns
 * (master plan wave 3, R; M5). Each column is bound to one component picked above the
 * table. A cell commits on blur or Enter (MoneyField), one PUT per commit; the server
 * recalculates in that request and its lines replace what is on screen. The grid never
 * computes PAYE or net. With no deduction editable there is no deduction column at all.
 *
 * The earning column opens on overtime or commission, never on Basic Salary: a once-off
 * typed there pays on top of the salary. It has no default when neither exists. What
 * the run pays every month on the component shows under the cell, for the same reason.
 *
 * Up, Down and Enter move along the column to the next row that has a cell, Tab along the row.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { AutosaveStatus } from '@/components/ui/AutosaveStatus';
import { MoneyField } from '@/components/ui/MoneyField';
import { PayrollRunLinesTable, type RunLineAmounts } from '@/components/payroll/PayrollRunLinesTable';
import { cellKey, type RowSave, type RunInputComponent, type RunInputs } from '@/components/payroll/useRunInputs';
import { formatCurrency } from '@/utils/formatters';

interface Props {
  runId: string;
  lines: RunLineAmounts[];
  inputs: RunInputs;
  saves: Record<string, RowSave>;
  resets: Record<string, number>;
  commit: (employeeId: string, componentId: string, cents: number) => void;
  refuse: (employeeId: string, componentId: string) => void;
  forgetRefused: (componentId: string) => void;
}

type Column = 'earning' | 'deduction';
const COLUMN_LABEL: Record<Column, string> = { earning: 'Once-off earning', deduction: 'Once-off deduction' };
// The label stays for screen readers; the header names the column. So does the echo: the cell shows the amount.
const CELL = 'w-40 min-w-40 [&_label]:sr-only [&_p[aria-live]]:sr-only';

const cellId = (runId: string, column: Column, row: number) => `run-${runId}-${column}-${row}`;

/** A row with a conflict, or a severance-only line, has no cell: the next one down the column that does. */
function moveOnKey(e: KeyboardEvent, runId: string, column: Column, row: number, rows: number) {
  const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' || e.key === 'Enter' ? 1 : 0;
  if (step === 0) return;
  e.preventDefault();
  for (let next = row + step; next >= 0 && next < rows; next += step) {
    const cell = document.getElementById(cellId(runId, column, next));
    if (cell) { cell.focus(); return; }
  }
}

/** The row's one status line: a failure stands until that cell saves, whichever cell saved since. */
function rowSave(saves: Record<string, RowSave>, employeeId: string): RowSave | undefined {
  const mine = Object.entries(saves).filter(([key]) => key.startsWith(`${employeeId}:`)).map(([, save]) => save);
  return mine.find((s) => s.state === 'error') ?? mine.find((s) => s.state === 'saving')
    ?? mine.reduce<RowSave | undefined>((latest, s) => ((s.savedAt ?? 0) >= (latest?.savedAt ?? 0) ? s : latest), undefined);
}

const defaultEarning = (earnings: RunInputComponent[]) =>
  earnings.find((c) => c.sarsSourceCode === '3607') ?? earnings.find((c) => c.sarsSourceCode === '3606');

function ComponentPicker({ column, options, value, onChange }: {
  column: Column; options: RunInputComponent[]; value: string; onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
      <span>{COLUMN_LABEL[column]}</span>
      <select aria-label={`${COLUMN_LABEL[column]} component`} value={value} onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-2 py-1 text-sm text-[var(--ff-text-primary)]">
        {!value && <option value="">Choose a component</option>}
        {options.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.sarsSourceCode})</option>)}
      </select>
    </label>
  );
}

export function PayRunReviewGrid({ runId, lines, inputs, saves, resets, commit, refuse, forgetRefused }: Props) {
  const earnings = inputs.components.filter((c) => c.componentType === 'earning');
  const deductions = inputs.components.filter((c) => c.componentType === 'deduction');
  const [pickedEarning, setEarningId] = useState('');
  const [pickedDeduction, setDeductionId] = useState('');
  // The default until another is picked, and again if the picked one leaves the catalogue.
  const earningId = earnings.find((c) => c.id === pickedEarning)?.id ?? defaultEarning(earnings)?.id ?? '';
  const deductionId = deductions.find((c) => c.id === pickedDeduction)?.id ?? deductions[0]?.id ?? '';
  // A column rebinding unmounts its cells (their key is the component): refused text in them is gone.
  useEffect(() => () => forgetRefused(earningId), [earningId, forgetRefused]);
  useEffect(() => () => forgetRefused(deductionId), [deductionId, forgetRefused]);

  const cell = (column: Column, componentId: string) => function RunInputCell(l: RunLineAmounts, row: number) {
    if (!componentId || !inputs.employeeIds.includes(l.employeeId)) {
      return <span className="text-[var(--ff-text-tertiary)]">—</span>;
    }
    const captured = inputs.amounts.find((a) => a.employeeId === l.employeeId && a.componentId === componentId);
    if (captured?.conflict) {
      return <Link href={`/payroll/employees/${l.employeeId}`} className="text-xs text-teal-700 dark:text-teal-300 underline">Edit on the employee page</Link>;
    }
    const recurring = inputs.recurring.find((r) => r.employeeId === l.employeeId && r.componentId === componentId);
    return (
      <div className={CELL} onKeyDown={(e) => moveOnKey(e, runId, column, row, lines.length)}>
        <MoneyField key={componentId} id={cellId(runId, column, row)} label={`${COLUMN_LABEL[column]}, ${l.employeeName}`}
          value={captured?.amount == null ? null : Math.round(captured.amount * 100)} resetKey={resets[cellKey(l.employeeId, componentId)] ?? 0}
          helperText={recurring ? `Plus ${formatCurrency(recurring.amount)} recurring` : undefined}
          onChange={(cents, validity) => {
            if (validity.valid) commit(l.employeeId, componentId, cents ?? 0);
            else refuse(l.employeeId, componentId);
          }} />
      </div>
    );
  };

  const save = (l: RunLineAmounts) => {
    const s = rowSave(saves, l.employeeId);
    return s ? <AutosaveStatus state={s.state} savedAt={s.savedAt} errorMessage={s.message} className="flex max-w-44" /> : null;
  };

  return (
    <>
      <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex flex-wrap items-center gap-x-6 gap-y-2">
        {earnings.length > 0 ? <ComponentPicker column="earning" options={earnings} value={earningId} onChange={setEarningId} /> : (
          <p className="text-xs text-[var(--ff-text-secondary)]">No earning can be edited on a pay run. SARS-coded earnings are captured on the employee page.</p>
        )}
        {deductions.length > 0 && <ComponentPicker column="deduction" options={deductions} value={deductionId} onChange={setDeductionId} />}
      </div>
      <div className="overflow-x-auto">
        <PayrollRunLinesTable lines={lines} edit={{
          earning: { head: COLUMN_LABEL.earning, cell: cell('earning', earningId) },
          deduction: deductions.length > 0 ? { head: COLUMN_LABEL.deduction, cell: cell('deduction', deductionId) } : undefined,
          statusCell: save,
        }} />
      </div>
    </>
  );
}
