/**
 * A pre-validation fix link (`/payroll/employees/<id>#employee-id-number`) lands on the field AND focuses it (wave 6
 * PV, browser review L6): scrolling alone leaves the keyboard where it was. On mount and on every hash change, when
 * the hash names one of `ids` and that element is a form field, it is focused (and scrolled into view).
 */
import { useEffect } from 'react';

export function useFocusHashField(ids: readonly string[]): void {
  const key = ids.join(' ');
  useEffect(() => {
    const allowed = key.split(' ');
    const focusHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!allowed.includes(id)) return;
      const field = document.getElementById(id);
      if (!field || !field.matches('input,select,textarea')) return;
      field.scrollIntoView?.({ block: 'center' });
      field.focus();
    };
    focusHash();
    window.addEventListener('hashchange', focusHash);
    return () => window.removeEventListener('hashchange', focusHash);
  }, [key]);
}
