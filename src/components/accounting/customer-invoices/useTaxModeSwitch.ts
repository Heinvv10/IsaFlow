/**
 * The new and edit invoice pages' "Amounts are" control (#1701 rounds 8-9): the mode the form prices in for the active
 * company (No VAT for one not registered, vatModeFor), the options it is offered (taxModesFor), and the switch
 * (taxModeSwitch.switchTaxMode: each line at its own rate; refused, prices and mode kept, when a line would move). A
 * refusal is kept as `problem` for InvoiceHeaderFields to show and announce by the selector. It is held against the
 * WHOLE input it was decided on (the lines' figures, the form rate, the date, the customer's VAT type, the mode it was
 * switched from, round 10) and dropped for good the moment any of them changes: an edit back to the old figures does
 * not bring it back, and a customer's defaults landing (which may change the mode) clear it. A re-render that rebuilds
 * the same lines keeps it.
 */
import { useEffect, useState } from 'react';
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor, type FormVatLine } from './formVat';
import { switchTaxMode, taxModesFor } from './taxModeSwitch';
import type { TaxMode } from './taxMode';

export interface TaxModeSwitchArgs<L extends FormVatLine & { description?: string }> {
  lines: L[]; setLines: (lines: L[]) => void;
  taxMode: TaxMode; setTaxMode: (mode: TaxMode) => void;
  formRate: number; date: string; customerVat?: string | null; currencyCode?: string;
  /** After a switch that went through (the new page records that the user chose the mode). */
  onSwitched?: () => void;
}

export function useTaxModeSwitch<L extends FormVatLine & { description?: string }>(a: TaxModeSwitchArgs<L>) {
  const registered = useVatRegistrationOrDefault().isRegistered;
  const [refused, setRefused] = useState<{ text: string; input: string } | null>(null);
  const input = JSON.stringify([a.lines.map((l) => [l.quantity, l.unitPrice, l.discount ?? 0]), a.formRate, a.date, a.customerVat ?? null, a.taxMode, registered, a.currencyCode ?? 'ZAR']);
  useEffect(() => { if (refused && refused.input !== input) setRefused(null); }, [input, refused]);
  const pick = (mode: TaxMode) => {
    const s = switchTaxMode(a.lines, { from: a.taxMode, to: mode, formRate: a.formRate, date: a.date, customerVat: a.customerVat, registered, currencyCode: a.currencyCode });
    if ('problem' in s) { setRefused({ text: s.problem, input }); return; }
    setRefused(null);
    a.onSwitched?.();
    a.setLines(s.lines);
    a.setTaxMode(s.mode);
  };
  const problem = refused && refused.input === input ? refused.text : null;
  return { vatMode: vatModeFor(registered, a.taxMode), modes: taxModesFor(registered), problem, pick };
}
