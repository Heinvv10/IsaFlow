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

let currentEnv: RiverEnv = { desktop: false, reducedMotion: false, saveData: false };
const listeners = new Set<() => void>();

export function setRiverEnv(env: RiverEnv): void {
  currentEnv = { ...env };
  listeners.clear();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return query === '(min-width: 768px)' ? currentEnv.desktop
        : query === '(prefers-reduced-motion: reduce)' ? currentEnv.reducedMotion
          : false;
    },
    media: query,
    addEventListener: (_type: string, cb: () => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: () => void) => { listeners.delete(cb); },
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'connection', { value: { saveData: env.saveData }, configurable: true });
}

/** Change the breakpoint or reduced-motion preference and fire every subscribed `change` listener. */
export function changeRiverEnv(patch: Partial<Omit<RiverEnv, 'saveData'>>): void {
  currentEnv = { ...currentEnv, ...patch };
  act(() => { for (const cb of Array.from(listeners)) cb(); });
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
