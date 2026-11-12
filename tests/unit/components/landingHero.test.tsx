/**
 * The River hero: fixed copy and CTAs, no stats bar and no demo button, a still image chosen by
 * media queries in the server HTML, and the intro-to-loop video only on a wide screen with motion
 * allowed and no data saver. Phones never get a <video> or an mp4 URL.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingHero } from '@/components/landing/LandingHero';
import { changeRiverEnv, setRiverEnv, stubMediaPlayback } from './landingRiverMocks';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DESKTOP = { desktop: true, reducedMotion: false, saveData: false };
const hero = (c: HTMLElement) => c.querySelector('#hero') as HTMLElement;
const videos = (c: HTMLElement) => Array.from(c.querySelectorAll('video'));

async function renderDesktop() {
  setRiverEnv(DESKTOP);
  const media = stubMediaPlayback();
  const r = render(<LandingHero />);
  await act(async () => { await Promise.resolve(); });
  const [loop, intro] = videos(r.container);
  return { ...r, ...media, loop: loop as HTMLVideoElement, intro: intro as HTMLVideoElement };
}

describe('LandingHero copy', () => {
  it('renders the headline, subline and both CTAs', () => {
    setRiverEnv({ desktop: false, reducedMotion: false, saveData: false });
    render(<LandingHero />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Keep the books flowing.');
    expect(screen.getByText('One calm flow from invoice to SARS-ready return.')).toBeTruthy();
    const primary = screen.getByRole('link', { name: /Start 30-day free trial, no card/ });
    expect(primary.getAttribute('href')).toBe('https://app.isaflow.co.za/register');
    const secondary = screen.getByRole('link', { name: 'For practices and bureaus' });
    expect(secondary.getAttribute('href')).toBe('/pricing#bureau');
  });

  it('has no stats bar, no figures and no demo button', () => {
    setRiverEnv({ desktop: false, reducedMotion: false, saveData: false });
    const { container } = render(<LandingHero />);
    const text = container.textContent ?? '';
    for (const gone of ['Watch Demo', 'Transactions Processed', 'Businesses', 'Invoices Processed']) {
      expect(text).not.toContain(gone);
    }
    expect(text).not.toMatch(/\d+\+/);
    expect(text).not.toMatch(/R \d/);
    expect(container.querySelector('a[href="#features"]')).toBeNull();
  });

  it('follows the copy rules', () => {
    setRiverEnv({ desktop: false, reducedMotion: false, saveData: false });
    const { container } = render(<LandingHero />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('\u2014');
    expect(text).not.toContain('ISAFlow');
    expect(text).not.toMatch(/submits? to SARS/i);
    expect(text).not.toMatch(/bank feed/i);
  });

  it('uses fixed colours only and marks itself as a dark surface', () => {
    setRiverEnv({ desktop: false, reducedMotion: false, saveData: false });
    const { container } = render(<LandingHero />);
    expect(hero(container).getAttribute('data-surface')).toBe('dark');
    for (const el of Array.from(container.querySelectorAll('[class]'))) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls).not.toContain('dark:');
      expect(cls).not.toContain('text-slate-');
      expect(cls).not.toContain('text-gray-');
    }
  });
});

describe('LandingHero media', () => {
  it('server HTML has the still picture and no video', () => {
    const html = renderToString(<LandingHero />);
    expect(html).not.toContain('<video');
    expect(html).not.toContain('.mp4');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Order matters: the browser takes the first matching <source>, so a reduced-motion phone must
    // hit the portrait still before the 1920px day poster.
    const sources = Array.from(doc.querySelectorAll('picture source')).map((s) => [s.getAttribute('media'), s.getAttribute('srcset')]);
    expect(sources).toEqual([
      ['(max-width: 767px)', '/landing/river/hero-mobile.webp'],
      ['(prefers-reduced-motion: reduce)', '/landing/river/hero-poster-day.webp'],
    ]);
    const img = doc.querySelector('picture img');
    expect(img?.getAttribute('src')).toBe('/landing/river/hero-poster-night.webp');
    expect(img?.getAttribute('width')).toBe('1920');
    expect(img?.getAttribute('height')).toBe('1080');
  });

  it.each([
    ['a phone', { desktop: false, reducedMotion: false, saveData: false }],
    ['reduced motion', { desktop: true, reducedMotion: true, saveData: false }],
    ['save-data', { desktop: true, reducedMotion: false, saveData: true }],
  ])('renders no video and no mp4 URL on %s', (_label, env) => {
    setRiverEnv(env);
    const { play } = stubMediaPlayback();
    const { container } = render(<LandingHero />);
    expect(videos(container)).toHaveLength(0);
    expect(container.innerHTML).not.toContain('.mp4');
    expect(hero(container).getAttribute('data-hero-phase')).toBe('still');
    expect(play).not.toHaveBeenCalled();
  });

  it('on desktop plays the intro once over a waiting loop', async () => {
    const { container, intro, loop, play } = await renderDesktop();
    expect(videos(container)).toHaveLength(2);
    expect(intro.getAttribute('src')).toMatch(/hero-intro\.mp4$/);
    expect(intro.getAttribute('poster')).toMatch(/hero-poster-night\.webp$/);
    expect(intro.autoplay).toBe(true);
    expect(intro.hasAttribute('playsinline')).toBe(true);
    expect(intro.muted).toBe(true);
    expect(intro.loop).toBe(false);
    expect(loop.getAttribute('src')).toMatch(/hero-loop\.mp4$/);
    expect(loop.loop).toBe(true);
    expect(loop.getAttribute('preload')).toBe('metadata');
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(intro);
    expect(hero(container).getAttribute('data-hero-phase')).toBe('intro');
  });

  it('warms the loop only in the last three seconds of the intro', async () => {
    const { intro, loop } = await renderDesktop();
    Object.defineProperty(intro, 'duration', { value: 10.5, configurable: true });
    Object.defineProperty(intro, 'currentTime', { value: 2, configurable: true, writable: true });
    fireEvent.timeUpdate(intro);
    expect(loop.getAttribute('preload')).toBe('metadata');
    Object.defineProperty(intro, 'currentTime', { value: 8, configurable: true, writable: true });
    fireEvent.timeUpdate(intro);
    expect(loop.getAttribute('preload')).toBe('auto');
  });

  it('keeps the intro last frame until the loop is actually playing', async () => {
    const { container, intro, loop, play } = await renderDesktop();
    fireEvent.ended(intro);
    expect(play.mock.contexts).toContain(loop);
    expect(hero(container).getAttribute('data-hero-phase')).toBe('intro');
    expect(intro.className).not.toContain('invisible');
    fireEvent.playing(loop);
    expect(hero(container).getAttribute('data-hero-phase')).toBe('loop');
    expect(intro.className).toContain('invisible');
  });

  it('falls back to the still when autoplay is refused', async () => {
    setRiverEnv(DESKTOP);
    stubMediaPlayback(true);
    const { container } = render(<LandingHero />);
    await waitFor(() => expect(videos(container)).toHaveLength(0));
    expect(hero(container).getAttribute('data-hero-phase')).toBe('still');
  });

  it('drops the video when the window narrows and brings it back when it widens', async () => {
    const { container, play } = await renderDesktop();
    changeRiverEnv({ desktop: false });
    expect(videos(container)).toHaveLength(0);
    expect(hero(container).getAttribute('data-hero-phase')).toBe('still');
    play.mockClear();
    changeRiverEnv({ desktop: true });
    await act(async () => { await Promise.resolve(); });
    expect(videos(container)).toHaveLength(2);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('drops the video when reduced motion is switched on', async () => {
    const { container } = await renderDesktop();
    changeRiverEnv({ reducedMotion: true });
    expect(videos(container)).toHaveLength(0);
  });

  it('starts the handoff over after the videos unmount and remount mid-loop', async () => {
    const { container, intro, loop } = await renderDesktop();
    Object.defineProperty(intro, 'duration', { value: 10.5, configurable: true });
    Object.defineProperty(intro, 'currentTime', { value: 9, configurable: true, writable: true });
    fireEvent.timeUpdate(intro);
    fireEvent.ended(intro);
    fireEvent.playing(loop);
    expect(hero(container).getAttribute('data-hero-phase')).toBe('loop');
    changeRiverEnv({ desktop: false });
    changeRiverEnv({ desktop: true });
    await act(async () => { await Promise.resolve(); });
    const [loop2, intro2] = videos(container) as [HTMLVideoElement, HTMLVideoElement];
    expect(hero(container).getAttribute('data-hero-phase')).toBe('intro');
    expect(intro2.className).not.toContain('invisible');
    expect(loop2.getAttribute('preload')).toBe('metadata');
  });
});
