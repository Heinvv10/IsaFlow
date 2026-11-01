/**
 * A DateField whose refusals feed a useDateGate: the page disables its submit while any gated date shows
 * refused text, and the refusal is dropped when the field leaves the screen (a closed panel, another tab).
 * `onValue` receives the ISO date, or '' when the field is empty; it is never called for refused text.
 *
 * A date the PARENT sets (a scan-fill, a form cleared after a save, a query param) needs `gate.reset(gateKey)` in the
 * same handler as the set:
 * - The field binds its value in its own render, after the parent's render has read `gate.blocked` (useDateGate keeps
 *   the bound value in a ref, and `blocked` compares against it). Over refused text, that render still reads blocked,
 *   and nothing renders the parent again once the field has bound, so `disabled={gate.blocked}` stays on until
 *   something else does. An event handler reading `gate.blocked` later is not affected.
 * - A prop that did not change is not news to DateField: setting the date the parent already holds leaves the refused
 *   text on screen, and clearing to '' looks like the echo of the refusal, so the text stays with the gate open.
 * To bind ahead of a read in the parent's render, use useDateGate.bind with a plain DateField (see balance-sheet.tsx).
 */
import { useEffect } from 'react';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';
import { useDateGate, type DateGate } from '@/hooks/useDateGate';
import { cn } from '@/utils/cn';

export { useDateGate };

export type GatedDateFieldProps = Omit<DateFieldProps, 'onChange' | 'resetKey'> & {
  gate: DateGate;
  gateKey: string;
  onValue: (iso: string) => void;
};

export function GatedDateField({ gate, gateKey, onValue, ...props }: GatedDateFieldProps) {
  const { bind, reset } = gate;
  useEffect(() => () => reset(gateKey), [reset, gateKey]);
  return <DateField resetKey={gate.resetKey(gateKey)} {...props} onChange={bind(gateKey, onValue, props.value)} />;
}

/**
 * For a report filter: says why the run and export actions are off, and what the screen shows meanwhile. Pass
 * `hidden` when the report is off the screen (useGatedReportLoad), so the notice does not point at a report that is not there.
 */
export function FixDateNotice({ gate, hidden, message, className }: {
  gate: DateGate;
  hidden?: boolean;
  message?: string;
  className?: string;
}) {
  if (!gate.blocked) return null;
  const text = message ?? (hidden ? 'Fix the date marked in red to run the report.' : 'Fix the date marked in red: the report shown is for the previous filters.');
  return <div role="alert" className={cn('p-3 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400 text-sm', className)}>{text}</div>;
}
