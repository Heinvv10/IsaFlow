/**
 * RunHoursCell — one employee's hours or days on the pay-run review grid (master plan wave 5, HD).
 * Parsed once, on blur or Enter (useParsedField, as MoneyField): whole or to two decimals, "7,5" read as 7.5, nothing else.
 * The cell sends the quantity only; the server prices it from the employee's rate and the echo under the cell is what it stored.
 * Hundredths in, hundredths out, so the field never carries a float.
 */
import Link from 'next/link';
import { Input } from '@/components/ui/Input';
import { useParsedField, type FieldValidity, type ParseOutcome } from '@/components/ui/useParsedField';
import { formatCurrency } from '@/utils/formatters';

type Code = 'unreadable' | 'above-max';
type Unit = 'hour' | 'day';
const MAX: Record<Unit, number> = { hour: 744, day: 31 };

const show = (hundredths: number) => String(hundredths / 100);

function parseQuantity(text: string, unit: Unit): ParseOutcome<number, Code> {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(t)) return { ok: false, code: 'unreadable', reason: `Enter ${unit === 'hour' ? 'hours' : 'days'} as a number, like 7.5.` };
  const hundredths = Math.round(Number(t.replace(',', '.')) * 100);
  if (hundredths > MAX[unit] * 100) return { ok: false, code: 'above-max', reason: `A month holds at most ${MAX[unit]} ${unit}s.` };
  return { ok: true, value: hundredths };
}

interface Props {
  id: string;
  employeeId: string;
  employeeName: string;
  unit: Unit;
  rate: number | null;
  /** The stored quantity and the amount the server priced it at. */
  quantity: number | null;
  amount: number | null;
  resetKey: number;
  onCommit: (hundredths: number) => void;
  onRefuse: () => void;
}

export function RunHoursCell({ id, employeeId, employeeName, unit, rate, quantity, amount, resetKey, onCommit, onRefuse }: Props) {
  const noun = unit === 'hour' ? 'Hours' : 'Days';
  const stored = quantity == null ? null : Math.round(quantity * 100);
  const field = useParsedField<number, Code>({
    value: stored, format: show, parse: (text) => parseQuantity(text, unit), resetKey,
    onChange: (hundredths: number | null, validity: FieldValidity<Code>) => {
      if (validity.valid) onCommit(hundredths ?? 0);
      else onRefuse();
    },
  });
  if (rate == null) {
    return (
      <Link href={`/payroll/employees/${employeeId}`} className="text-xs text-teal-700 dark:text-teal-300 underline">
        Set the {unit}ly rate first
      </Link>
    );
  }
  const priced = amount != null && quantity != null ? `${formatCurrency(amount)} at ${formatCurrency(rate)} per ${unit}` : `${formatCurrency(rate)} per ${unit}`;
  return (
    <div className="w-40 min-w-40 [&_label]:sr-only">
      <Input id={id} label={`${noun}, ${employeeName}`} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
        value={field.text} placeholder="0" error={field.error ?? undefined} helperText={priced} className="text-right tabular-nums"
        onChange={(e) => field.onTextChange(e.target.value)} onBlur={() => field.commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') field.commit(); }} />
    </div>
  );
}
