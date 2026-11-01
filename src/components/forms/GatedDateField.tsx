/**
 * A DateField whose refusals feed a useDateGate: the page disables its submit while any gated date shows
 * refused text, and the refusal is dropped when the field leaves the screen (a closed panel, another tab).
 * `onValue` receives the ISO date, or '' when the field is empty; it is never called for refused text.
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
