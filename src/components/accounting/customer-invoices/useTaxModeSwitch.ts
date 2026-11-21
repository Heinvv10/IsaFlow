/**
 * The new and edit invoice pages' "Amounts are" control (#1701 rounds 8-9): the mode the form prices in for the active
 * company (No VAT for one not registered, vatModeFor), the options it is offered (taxModesFor), and the switch
 * (taxModeSwitch.switchTaxMode: each line at its own rate; refused, prices and mode kept, when a line would move). A
 * refusal is kept as `problem` for InvoiceHeaderFields to show and announce by the selector; it clears on the next
 * switch that goes through and once the lines' figures (quantity, price, discount) are edited. Held against those
 * figures, not the lines' identity: a re-render that rebuilds the same lines (a customer's defaults landing) keeps it.
 */
import { useState } from 'react';
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import { vatModeFor, type FormVatLine } from './formVat';
import { switchTaxMode, taxModesFor } from './taxModeSwitch';
import type { TaxMode } from './taxMode';

export interface TaxModeSwitchArgs<L extends FormVatLine & { description?: string }> {
  lines: L[]; setLines: (lines: L[]) => void;
  taxMode: TaxMode; setTaxMode: (mode: TaxMode) => void;
  formRate: number; date: string; customerVat?: string | null;
  /** After a switch that went through (the new page records that the user chose the mode). */
  onSwitched?: () => void;
}

export function useTaxModeSwitch<L extends FormVatLine & { description?: string }>(a: TaxModeSwitchArgs<L>) {
  const registered = useVatRegistrationOrDefault().isRegistered;
  const [refused, setRefused] = useState<{ text: string; figures: string } | null>(null);
  const figures = JSON.stringify(a.lines.map((l) => [l.quantity, l.unitPrice, l.discount ?? 0]));
  const pick = (mode: TaxMode) => {
    const s = switchTaxMode(a.lines, { from: a.taxMode, to: mode, formRate: a.formRate, date: a.date, customerVat: a.customerVat, registered });
    if ('problem' in s) { setRefused({ text: s.problem, figures }); return; }
    setRefused(null);
    a.onSwitched?.();
    a.setLines(s.lines);
    a.setTaxMode(s.mode);
  };
  const problem = refused && refused.figures === figures ? refused.text : null;
  return { vatMode: vatModeFor(registered, a.taxMode), modes: taxModesFor(registered), problem, pick };
}
