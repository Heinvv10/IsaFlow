/**
 * Shared stubs for the River hero and South Africa band tests: media queries, save-data,
 * IntersectionObserver and HTMLMediaElement playback. happy-dom has inert versions of all three.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export interface RiverEnv {
  desktop: boolean;
  reducedMotion: boolean;
  saveData: boolean;
}

export function setRiverEnv({ desktop, reducedMotion, saveData }: RiverEnv): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(min-width: 768px)' ? desktop
      : query === '(prefers-reduced-motion: reduce)' ? reducedMotion
        : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'connection', { value: { saveData }, configurable: true });
}

interface FakeObserver {
  options: IntersectionObserverInit;
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}

export function installIntersectionObserver(): {
  instances: FakeObserver[];
  fire: (match: (o: IntersectionObserverInit) => boolean, isIntersecting: boolean) => void;
} {
  const instances: FakeObserver[] = [];
  class FakeIO {
    private readonly rec: FakeObserver;
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.rec = { options, callback, observed: [], disconnected: false };
      instances.push(this.rec);
    }
    observe(el: Element): void { this.rec.observed.push(el); }
    unobserve(): void { /* not used by the components */ }
    disconnect(): void { this.rec.disconnected = true; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);
  return {
    instances,
    fire(match, isIntersecting) {
      act(() => {
        for (const rec of instances) {
          if (rec.disconnected || !match(rec.options)) continue;
          const target = rec.observed[0];
          if (!target) continue;
          const entry = { isIntersecting, target } as unknown as IntersectionObserverEntry;
          rec.callback([entry], rec as unknown as IntersectionObserver);
        }
      });
    },
  };
}

export function stubMediaPlayback(reject = false) {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
    (reject ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()));
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  return { play, pause };
}
