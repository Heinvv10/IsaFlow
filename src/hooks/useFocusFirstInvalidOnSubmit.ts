/**
 * On a phone, a failed submit often leaves the error off screen: the user taps Save, nothing seems to happen.
 * After a form submits, this looks (below lg only) for the first field the form marks `aria-invalid="true"` and
 * moves focus and scroll to it. Most forms in the app show a red banner instead of flagging fields: when no field
 * is flagged but a new or changed error banner appeared, that banner is scrolled into view (not focused).
 *
 * Errors can arrive after a server round-trip, so it keeps looking for WATCH_MS, once per submit; a later submit
 * (of any form) replaces the earlier watch. It never pulls focus out of a field that is already invalid. A field
 * that was already invalid before the submit still counts: tapping Save twice over the same error must land on it
 * again. Banners are looked for only in the form's own container (its dialog, else its parent), never toasts
 * (fixed position) and never inline chips. Mount once, in the app shell.
 */
import { useEffect } from 'react';

const PHONE = '(max-width: 1023.98px)';
const INVALID = '[aria-invalid="true"]:not([disabled]):not([type="hidden"])';
// An error banner: role=alert or data-form-error anywhere, or the red tinted box the app's forms use, as a block.
const BANNER = '[role="alert"], [data-form-error], div.bg-red-500\\/10, p.bg-red-500\\/10';
const WATCH_MS = 6000;
const STEP_MS = 100;

const visible = (el: Element): boolean => {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const html = el as HTMLElement;
  return typeof html.checkVisibility === 'function' ? html.checkVisibility() : el.getClientRects().length > 0;
};
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const banners = (scope: ParentNode) => [...scope.querySelectorAll(BANNER)].filter((b) => !b.closest('.fixed'));

export function useFocusFirstInvalidOnSubmit(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !window.matchMedia(PHONE).matches) return;
      clearTimeout(timer);
      const scope: ParentNode = form.closest('[role="dialog"]') ?? form.parentElement ?? form;
      const before = new Map(banners(scope).map((b) => [b, b.textContent]));
      const started = Date.now();
      const look = () => {
        // A form that React replaced (a key change, a modal swapped for a spinner) ends the watch.
        if (!form.isConnected) return;
        const target = [...form.querySelectorAll<HTMLElement>(INVALID)].find(visible);
        if (target) {
          const active = document.activeElement;
          if (active === target || (active instanceof HTMLElement && active.matches(INVALID) && form.contains(active))) return;
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
          return;
        }
        const banner = banners(scope).find((b) => before.get(b) !== b.textContent && b.textContent?.trim() && visible(b));
        if (banner) { banner.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); return; }
        if (Date.now() - started < WATCH_MS) timer = setTimeout(look, STEP_MS);
      };
      timer = setTimeout(look, 0);
    };
    document.addEventListener('submit', onSubmit, true);
    return () => { document.removeEventListener('submit', onSubmit, true); clearTimeout(timer); };
  }, []);
}
