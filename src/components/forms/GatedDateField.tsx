/**
 * A DateField whose refusals feed a useDateGate: the page disables its submit while any gated date shows
 * refused text, and the refusal is dropped when the field leaves the screen (a closed panel, another tab).
 * `onValue` receives the ISO date, or '' when the field is empty; it is never called for refused text.
 */
import { useEffect } from 'react';
import { DateField, type DateFieldProps } from '@/components/ui/DateField';
import { useDateGate, type DateGate } from '@/hooks/useDateGate';

export { useDateGate };

export type GatedDateFieldProps = Omit<DateFieldProps, 'onChange'> & {
  gate: DateGate;
  gateKey: string;
  onValue: (iso: string) => void;
};

export function GatedDateField({ gate, gateKey, onValue, ...props }: GatedDateFieldProps) {
  const { bind, forget } = gate;
  useEffect(() => () => forget(gateKey), [forget, gateKey]);
  return <DateField {...props} onChange={bind(gateKey, onValue)} />;
}
