/**
 * The new and edit invoice pages' "Amounts are" control (#1701 rounds 8-9): the mode the form prices in for the active
 * company (No VAT for one not registered, vatModeFor), the options it is offered (taxModesFor), and the switch
 * (taxModeSwitch.switchTaxMode: each line at its own type's rate; refused, prices and mode kept, when a line would move).
 * A refusal is kept as `problem` for the settings row to show and announce by the selector. It is held against the
 * WHOLE input it was decided on (the lines' figures and VAT types, the date, the mode it was switched from, round 10)
 * and dropped for good the moment any of them changes: an edit back to the old figures does not bring it back, and a
 * customer's defaults landing (which may re-type the lines) clear it. A re-render that rebuilds the same lines keeps it.
 */
import { useEffect, useState } from 'react';
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor, type FormVatLine, type LineVatTypeOrNone } from './formVat';
import { switchTaxMode, taxModesFor, type ModeSwitch } from './taxModeSwitch';
import type { TaxMode } from './taxMode';

export interface TaxModeSwitchArgs<L extends FormVatLine & { description?: string }> {
  lines: L[]; setLines: (lines: L[]) => void;
  taxMode: TaxMode; setTaxMode: (mode: TaxMode) => void;
  /** Each line's VAT type as the page resolves it (formVat.lineVatTypes). */
  types: readonly LineVatTypeOrNone[];
  date: string; currencyCode?: string;
  /** After a switch that went through. */
  onSwitched?: () => void;
  /** The pricing the refusal check compares (switchTaxMode's `price`). */
  price?: ModeSwitch['price'];
}

export function useTaxModeSwitch<L extends FormVatLine & { description?: string }>(a: TaxModeSwitchArgs<L>) {
  const registered = useVatRegistrationOrDefault().isRegistered;
  const [refused, setRefused] = useState<{ text: string; input: string } | null>(null);
  const from = vatModeFor(registered, a.taxMode);
  const input = JSON.stringify([a.lines.map((l) => [l.quantity, l.unitPrice, l.discount ?? 0]), a.types, a.date, from, registered, a.currencyCode ?? 'ZAR']);
  useEffect(() => { if (refused && refused.input !== input) setRefused(null); }, [input, refused]);
  const pick = (mode: TaxMode) => {
    const s = switchTaxMode(a.lines, { from, to: mode, date: a.date, types: a.types, registered, currencyCode: a.currencyCode, price: a.price });
    if ('problem' in s) { setRefused({ text: s.problem, input }); return; }
    setRefused(null);
    a.onSwitched?.();
    a.setLines(s.lines);
    a.setTaxMode(s.mode);
  };
  const problem = refused && refused.input === input ? refused.text : null;
  return { vatMode: from, registered, modes: taxModesFor(registered), problem, pick };
}
