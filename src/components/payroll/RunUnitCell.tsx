/**
 * RunUnitCell — one employee's overtime hours, or travel km and the rate a km, on the pay-run review grid (wave 6 RI).
 * Parsed once, on blur or Enter (useParsedField), as RunHoursCell: whole or to two decimals, "7,5" read as 7.5. The cell
 * sends the quantity (and, for travel, the rate a km); the server prices it and the echo under the cell is what it stored.
 * Hundredths in, hundredths out. A travel row commits only with both its km and its rate.
 */
import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { MoneyField } from '@/components/ui/MoneyField';
import { useParsedField, type FieldValidity, type ParseOutcome } from '@/components/ui/useParsedField';
import { formatCurrency } from '@/utils/formatters';

type Code = 'unreadable' | 'above-max';
type Kind = 'overtime' | 'travel';
const MAX: Record<Kind, number> = { overtime: 744, travel: 99_999.99 };
const NOUN: Record<Kind, string> = { overtime: 'hours', travel: 'km' };

function parseQuantity(text: string, kind: Kind): ParseOutcome<number, Code> {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(t)) return { ok: false, code: 'unreadable', reason: `Enter ${NOUN[kind]} as a number, like 7.5.` };
  const hundredths = Math.round(Number(t.replace(',', '.')) * 100);
  if (hundredths > Math.round(MAX[kind] * 100)) return { ok: false, code: 'above-max', reason: `At most ${MAX[kind]} ${NOUN[kind]}.` };
  return { ok: true, value: hundredths };
}

interface Props {
  id: string;
  kind: Kind;
  /** The accessible name, e.g. "Overtime hours at 1.5x, Thandi Mokoena". */
  label: string;
  /** The stored quantity and the amount the server priced it at. */
  quantity: number | null;
  amount: number | null;
  /** Overtime: the hourly rate it is priced at (null: it cannot be priced) and the multiplier. */
  hourlyRate?: number | null;
  multiplier?: number;
  resetKey: number;
  /** Travel: km recorded this tax year to this month (shown only; tax does not turn on distance). */
  kmThisTaxYear?: number | null;
  /** Hundredths of hours or km (null clears the row), and for travel the rate a km in cents. */
  onCommit: (hundredths: number | null, rateCents: number | null) => void;
  onRefuse: () => void;
}

export function RunUnitCell({ id, kind, label, quantity, amount, hourlyRate, multiplier, resetKey, kmThisTaxYear, onCommit, onRefuse }: Props) {
  const stored = quantity == null ? null : Math.round(quantity * 100);
  const storedRate = quantity != null && quantity > 0 && amount != null ? Math.round((amount / quantity) * 100) : null;
  const [rateCents, setRateCents] = useState<number | null>(storedRate);
  // The km last committed in this cell (saved or waiting for its rate), so a rate typed after the km sends both.
  const [typed, setTyped] = useState<number | null>(stored);
  const field = useParsedField<number, Code>({
    value: stored, format: (h) => String(h / 100), parse: (text) => parseQuantity(text, kind), resetKey,
    onChange: (hundredths: number | null, validity: FieldValidity<Code>) => {
      if (!validity.valid) { onRefuse(); return; }
      setTyped(hundredths);
      if (kind === 'overtime' || hundredths == null || rateCents != null) onCommit(hundredths, kind === 'travel' ? rateCents : null);
    },
  });
  const helper = amount != null && quantity != null ? `${formatCurrency(amount)} paid`
    : kind === 'overtime' ? (hourlyRate == null ? 'No hourly rate: set it on the employee page' : `${formatCurrency(hourlyRate)} an hour x ${multiplier}`)
      : 'Enter km and the rate a km';
  return (
    <div className="w-40 min-w-40 space-y-1 [&_label]:sr-only">
      <Input id={id} label={label} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
        value={field.text} placeholder="0" error={field.error ?? undefined} helperText={helper} className="text-right tabular-nums"
        disabled={kind === 'overtime' && hourlyRate == null}
        onChange={(e) => field.onTextChange(e.target.value)} onBlur={() => field.commit()}
        onKeyDown={(e) => { if (e.key === 'Enter') field.commit(); }} />
      {kind === 'travel' && (
        <MoneyField id={`${id}-rate`} label={`Rate a km, ${label}`} value={rateCents} resetKey={resetKey} placeholder="Rate a km"
          onChange={(cents, validity) => {
            if (!validity.valid) { onRefuse(); return; }
            setRateCents(cents);
            if (cents != null && typed != null) onCommit(typed, cents);
          }} />
      )}
      {kind === 'travel' && kmThisTaxYear != null && (
        <p className="text-xs text-[var(--ff-text-secondary)] tabular-nums">{kmThisTaxYear.toLocaleString('en-ZA')} km this tax year</p>
      )}
    </div>
  );
}
