/**
 * PayRunReviewGrid — a draft or calculated run's lines with two editable once-off
 * columns (master plan wave 3, R; M5). Each column is bound to one component picked
 * above the table. A cell commits on blur or Enter (MoneyField), one PUT per commit;
 * the server recalculates in that request and its lines replace what is on screen.
 * The grid never computes PAYE or net.
 *
 * Up, Down and Enter move along the column, Tab along the row.
 */
import { useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { AutosaveStatus } from '@/components/ui/AutosaveStatus';
import { MoneyField } from '@/components/ui/MoneyField';
import { PayrollRunLinesTable, type RunLineAmounts } from '@/components/payroll/PayrollRunLinesTable';
import type { RowSave, RunInputComponent, RunInputs } from '@/components/payroll/useRunInputs';

interface Props {
  runId: string;
  lines: RunLineAmounts[];
  inputs: RunInputs;
  saves: Record<string, RowSave>;
  resetKey: number;
  commit: (employeeId: string, componentId: string, cents: number) => void;
}

type Column = 'earning' | 'deduction';
const COLUMN_LABEL: Record<Column, string> = { earning: 'Once-off earning', deduction: 'Once-off deduction' };
// The label stays for screen readers; the header names the column. So does the echo: the cell shows the amount.
const CELL = 'w-40 min-w-40 [&_label]:sr-only [&_p[aria-live]]:sr-only';

const cellId = (runId: string, column: Column, row: number) => `run-${runId}-${column}-${row}`;

function moveOnKey(e: KeyboardEvent, runId: string, column: Column, row: number) {
  const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' || e.key === 'Enter' ? 1 : 0;
  if (step === 0) return;
  e.preventDefault();
  document.getElementById(cellId(runId, column, row + step))?.focus();
}

function ComponentPicker({ column, options, value, onChange }: {
  column: Column; options: RunInputComponent[]; value: string; onChange: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="text-xs text-[var(--ff-text-secondary)]">
        No {column} can be edited on a pay run. SARS-coded {column}s are captured on the employee page.
      </p>
    );
  }
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
      <span>{COLUMN_LABEL[column]}</span>
      <select aria-label={`${COLUMN_LABEL[column]} component`} value={value} onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-2 py-1 text-sm text-[var(--ff-text-primary)]">
        {options.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.sarsSourceCode})</option>)}
      </select>
    </label>
  );
}

export function PayRunReviewGrid({ runId, lines, inputs, saves, resetKey, commit }: Props) {
  const earnings = inputs.components.filter((c) => c.componentType === 'earning');
  const deductions = inputs.components.filter((c) => c.componentType === 'deduction');
  const [pickedEarning, setEarningId] = useState('');
  const [pickedDeduction, setDeductionId] = useState('');
  // The first one until another is picked, and again if the picked one leaves the catalogue.
  const earningId = earnings.find((c) => c.id === pickedEarning)?.id ?? earnings[0]?.id ?? '';
  const deductionId = deductions.find((c) => c.id === pickedDeduction)?.id ?? deductions[0]?.id ?? '';

  const cell = (column: Column, componentId: string) => function RunInputCell(l: RunLineAmounts, row: number) {
    if (!componentId || !inputs.employeeIds.includes(l.employeeId)) {
      return <span className="text-[var(--ff-text-tertiary)]">—</span>;
    }
    const captured = inputs.amounts.find((a) => a.employeeId === l.employeeId && a.componentId === componentId);
    if (captured?.conflict) {
      return <Link href={`/payroll/employees/${l.employeeId}`} className="text-xs text-teal-500 underline">Edit on the employee page</Link>;
    }
    return (
      <div className={CELL} onKeyDown={(e) => moveOnKey(e, runId, column, row)}>
        <MoneyField key={componentId} id={cellId(runId, column, row)} label={`${COLUMN_LABEL[column]}, ${l.employeeName}`}
          value={captured?.amount == null ? null : Math.round(captured.amount * 100)} resetKey={resetKey}
          onChange={(cents, validity) => { if (validity.valid) commit(l.employeeId, componentId, cents ?? 0); }} />
      </div>
    );
  };

  const save = (l: RunLineAmounts) => {
    const s = saves[l.employeeId];
    return s ? <AutosaveStatus state={s.state} savedAt={s.savedAt} errorMessage={s.message} className="w-44" /> : null;
  };

  return (
    <>
      <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex flex-wrap items-center gap-x-6 gap-y-2">
        <ComponentPicker column="earning" options={earnings} value={earningId} onChange={setEarningId} />
        <ComponentPicker column="deduction" options={deductions} value={deductionId} onChange={setDeductionId} />
      </div>
      <div className="overflow-x-auto">
        <PayrollRunLinesTable lines={lines} edit={{
          earningHead: COLUMN_LABEL.earning, earningCell: cell('earning', earningId),
          deductionHead: COLUMN_LABEL.deduction, deductionCell: cell('deduction', deductionId),
          statusCell: save,
        }} />
      </div>
    </>
  );
}
