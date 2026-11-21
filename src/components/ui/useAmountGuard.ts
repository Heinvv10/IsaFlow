/**
 * For a save handler that is a plain `onClick` (no <form> submit, so the browser's own check never runs): put `guard.ref`
 * on the element that holds the page's AmountInputs and start the handler with `if (guard.blocked()) return;`. A refused
 * paste, a lone "." or a value outside min/max then blocks the save and shows the field's message, instead of the handler
 * parsing the text (Number('.') is NaN; parseFloat('.') is NaN, which a `? x : null` turns into "no cap").
 */
import { useRef } from 'react';
import { blockOnInvalidAmount } from './amountInputText';

export function useAmountGuard<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  return { ref, blocked: (): boolean => blockOnInvalidAmount(ref.current) };
}
