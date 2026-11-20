/**
 * On a phone, a failed submit often leaves the invalid field off screen: the user taps Save, nothing seems to
 * happen. After any form submits, this looks for the first field the form marked `aria-invalid="true"` and
 * moves focus and scroll to it. Errors can arrive after a server round-trip, so it keeps looking for a short
 * while and acts once per submit. Most forms in the app show a red banner instead of flagging fields: when the
 * submit leaves no invalid field but a new error banner appeared, that banner is scrolled into view (not focused).
 * Phones only (below lg); it never pulls focus out of a field that is already
 * invalid, and it does nothing when the submit left no invalid field. Mount once, in the app layout.
 */
import { useEffect } from 'react';

const PHONE = '(max-width: 1023.98px)';
const INVALID = '[aria-invalid="true"]:not([disabled]):not([type="hidden"])';
// An error banner: role=alert, or the red tinted box the app's forms use for a failed save.
const BANNER = '[role="alert"], [data-form-error], .bg-red-500\\/10';
const WATCH_MS = 1500;
const STEP_MS = 100;

const shown = (el: Element) => !el.closest('[hidden], [aria-hidden="true"]') && Boolean(el.textContent?.trim());

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function firstInvalid(form: HTMLFormElement): HTMLElement | null {
  return [...form.querySelectorAll<HTMLElement>(INVALID)].find((el) => !el.closest('[hidden], [aria-hidden="true"]')) ?? null;
}

export function useFocusFirstInvalidOnSubmit(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !window.matchMedia(PHONE).matches) return;
      clearTimeout(timer);
      const before = new Set(document.querySelectorAll(BANNER));
      const started = Date.now();
      const look = () => {
        if (!form.isConnected) return;
        const target = firstInvalid(form);
        if (target) {
          const active = document.activeElement;
          if (active === target || (active instanceof HTMLElement && active.matches(INVALID) && form.contains(active))) return;
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
          return;
        }
        const banner = [...document.querySelectorAll(BANNER)].find((b) => !before.has(b) && shown(b));
        if (banner) { banner.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); return; }
        if (Date.now() - started < WATCH_MS) timer = setTimeout(look, STEP_MS);
      };
      timer = setTimeout(look, 0);
    };
    document.addEventListener('submit', onSubmit, true);
    return () => { document.removeEventListener('submit', onSubmit, true); clearTimeout(timer); };
  }, []);
}
