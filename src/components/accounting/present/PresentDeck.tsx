/**
 * A pack, on a boardroom screen. No app chrome, one slide in the DOM at a
 * time, and every paging action reachable from the keyboard — a presenter
 * has one hand on a clicker, which sends arrow keys and Page Up/Down.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { log } from '@/lib/logger';
import { clampSlide, type Slide } from './presentSlides';

const FORWARD = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'Enter']);
const BACK = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);
const TYPING_ELEMENTS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return TYPING_ELEMENTS.has(target.tagName) || target.isContentEditable;
}

export interface PresentDeckProps {
  slides: Slide[];
  renderSlide: (slide: Slide, index: number) => ReactNode;
  onExit?: () => void;
}

export function PresentDeck({ slides, renderSlide, onExit }: PresentDeckProps) {
  const [index, setIndex] = useState(0);
  const count = slides.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        onExit?.();
        if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
          document.exitFullscreen().catch((err: unknown) => {
            log.debug('Exiting fullscreen failed', { error: err }, 'PresentDeck');
          });
        }
        return;
      }
      if (FORWARD.has(e.key)) { e.preventDefault(); setIndex((i) => clampSlide(i + 1, count)); return; }
      if (BACK.has(e.key)) { e.preventDefault(); setIndex((i) => clampSlide(i - 1, count)); return; }
      if (e.key === 'Home') { setIndex(clampSlide(0, count)); return; }
      if (e.key === 'End') { setIndex(clampSlide(count - 1, count)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onExit]);

  useEffect(() => {
    // Full screen needs a user gesture in several browsers and does not
    // exist in the test DOM. A refusal is normal, not an error.
    const el = document.documentElement;
    if (typeof el.requestFullscreen !== 'function') return;
    el.requestFullscreen().catch((err: unknown) => {
      log.debug('Presentation mode stayed windowed', { error: err }, 'PresentDeck');
    });
  }, []);

  const current = slides[index];
  if (!current) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <p className="text-sm text-[var(--ff-text-secondary)]">This pack has no slides.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-[var(--ff-bg-primary)] px-10 py-8">
      <section className="flex-1 overflow-auto" aria-live="polite">
        {renderSlide(current, index)}
      </section>
      <footer className="mt-6 flex items-center justify-end text-xs text-[var(--ff-text-tertiary)]">
        <span className="tabular-nums">{index + 1} / {count}</span>
      </footer>
    </main>
  );
}
