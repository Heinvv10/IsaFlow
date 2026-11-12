import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

export const DESKTOP_QUERY = '(min-width: 768px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

type SaveDataNavigator = Navigator & { connection?: { saveData?: boolean } };

function allowsVideo(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches
    && !window.matchMedia(REDUCED_MOTION_QUERY).matches
    && (navigator as SaveDataNavigator).connection?.saveData !== true;
}

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(REDUCED_MOTION_QUERY)];
  queries.forEach((q) => q.addEventListener('change', onChange));
  return () => queries.forEach((q) => q.removeEventListener('change', onChange));
}

/**
 * True only on a wide screen with motion allowed and no data saver. False on the server and
 * during hydration, so no <video> (and no mp4 URL) is ever in the HTML a phone receives.
 */
export function useRiverVideoAllowed(): boolean {
  return useSyncExternalStore(subscribe, allowsVideo, () => false);
}

/**
 * IntersectionObserver as state. `enabled` false means no observer is created.
 * `once` latches: after the first intersection the observer disconnects and the value stays true.
 */
export function useInView(
  ref: RefObject<Element | null>,
  options: { rootMargin: string; threshold: number; once?: boolean },
  enabled: boolean,
): boolean {
  const [inView, setInView] = useState(false);
  const { rootMargin, threshold, once = false } = options;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const io = new IntersectionObserver(([entry]) => {
      const hit = entry?.isIntersecting === true;
      if (once) {
        if (hit) {
          setInView(true);
          io.disconnect();
        }
      } else {
        setInView(hit);
      }
    }, { rootMargin, threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, rootMargin, threshold, once]);
  return enabled && inView;
}
