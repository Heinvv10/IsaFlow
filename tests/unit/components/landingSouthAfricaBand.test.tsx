/**
 * The "Built in South Africa" band: verified copy, a poster strip in still mode (server, phones,
 * reduced motion, save-data, refused playback), and on desktop three lazy landmark clips that get
 * a src only when the band is near and play in order once each time it comes into view.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingSouthAfricaBand } from '@/components/landing/LandingSouthAfricaBand';
import { installIntersectionObserver, setRiverEnv, stubMediaPlayback } from './landingRiverMocks';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DESKTOP = { desktop: true, reducedMotion: false, saveData: false };
const PHONE = { desktop: false, reducedMotion: false, saveData: false };
const isNear = (o: IntersectionObserverInit) => o.rootMargin === '600px 0px';
const isInView = (o: IntersectionObserverInit) => o.rootMargin === '0px';
const videos = (c: HTMLElement) => Array.from(c.querySelectorAll('video'));
const visibleIndex = (c: HTMLElement) => videos(c).findIndex((v) => !v.className.includes('invisible'));

const FACTS: [string, string][] = [
  ['SARS-ready returns', 'VAT201 and EMP201 prepared for you to file on eFiling. EMP501 and IRP5/IT3(a) prepared for you to submit through e@syFile Employer.'],
  ['South African payroll rules', 'Payroll calculates PAYE, UIF and SDL, produces payslips, and prepares EMP201 and IRP5 data.'],
  ['POPIA and local hosting', 'Our application and database servers are hosted in South Africa, and we handle personal information under POPIA, as set out in our privacy policy.'],
  ['Rand pricing, Pretoria head office', 'Prices are in rand and include 15% VAT. Our head office is in Pretoria, South Africa.'],
];

function renderDesktop() {
  setRiverEnv(DESKTOP);
  const io = installIntersectionObserver();
  const media = stubMediaPlayback();
  const r = render(<LandingSouthAfricaBand />);
  return { ...r, ...media, io, clips: () => videos(r.container) };
}

describe('LandingSouthAfricaBand still mode', () => {
  it('renders the verified copy and the poster strip', () => {
    setRiverEnv(PHONE);
    installIntersectionObserver();
    const { container } = render(<LandingSouthAfricaBand />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Built in South Africa, for South African books');
    const dts = Array.from(container.querySelectorAll('dt')).map((d) => d.textContent);
    const dds = Array.from(container.querySelectorAll('dd')).map((d) => d.textContent);
    expect(dts).toEqual(FACTS.map(([t]) => t));
    expect(dds).toEqual(FACTS.map(([, d]) => d));
    const imgs = Array.from(container.querySelectorAll('img'));
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([
      '/landing/sa/landmark-capetown-poster.webp',
      '/landing/sa/landmark-joburg-poster.webp',
      '/landing/sa/landmark-pretoria-poster.webp',
    ]);
    for (const img of imgs) {
      expect(img.getAttribute('alt')).toBeTruthy();
      expect(img.getAttribute('width')).toBe('1280');
      expect(img.getAttribute('height')).toBe('720');
      expect(img.getAttribute('loading')).toBe('lazy');
    }
    const text = container.textContent ?? '';
    for (const place of ['Cape Town', 'Johannesburg', 'Pretoria']) expect(text).toContain(place);
    expect(screen.getByRole('link', { name: 'privacy policy' }).getAttribute('href')).toBe('/privacy');
  });

  it.each([
    ['a phone', PHONE],
    ['reduced motion', { desktop: true, reducedMotion: true, saveData: false }],
    ['save-data', { desktop: true, reducedMotion: false, saveData: true }],
  ])('never creates an observer, a video or an mp4 URL on %s', (_label, env) => {
    setRiverEnv(env);
    const io = installIntersectionObserver();
    const { play } = stubMediaPlayback();
    const { container } = render(<LandingSouthAfricaBand />);
    io.fire(() => true, true);
    expect(io.instances).toHaveLength(0);
    expect(videos(container)).toHaveLength(0);
    expect(container.innerHTML).not.toContain('.mp4');
    expect(play).not.toHaveBeenCalled();
  });

  it('server HTML has no video', () => {
    const html = renderToString(<LandingSouthAfricaBand />);
    expect(html).not.toContain('<video');
    expect(html).not.toContain('.mp4');
  });

  it('follows the copy rules and marks itself as a dark surface', () => {
    setRiverEnv(PHONE);
    installIntersectionObserver();
    const { container } = render(<LandingSouthAfricaBand />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('\u2014');
    expect(text).not.toContain('ISAFlow');
    expect(text).not.toMatch(/submits? to SARS/i);
    expect(text).not.toMatch(/bank feed/i);
    expect(text).not.toMatch(/live feed/i);
    expect(text).not.toContain('ABSA');
    expect(container.querySelector('#south-africa')?.getAttribute('data-surface')).toBe('dark');
    for (const el of Array.from(container.querySelectorAll('[class]'))) {
      expect(el.getAttribute('class') ?? '').not.toContain('dark:');
    }
  });
});

describe('LandingSouthAfricaBand film', () => {
  it('has three src-less clips before the band is near', () => {
    const { container, clips, play } = renderDesktop();
    expect(clips()).toHaveLength(3);
    for (const v of clips()) {
      expect(v.hasAttribute('src')).toBe(false);
      expect(v.getAttribute('preload')).toBe('none');
      expect(v.getAttribute('poster')).toMatch(/landmark-.*-poster\.webp$/);
    }
    expect(container.innerHTML).not.toContain('.mp4');
    expect(play).not.toHaveBeenCalled();
  });

  it('sets the sources in order when near, without playing', () => {
    const { io, clips, play } = renderDesktop();
    io.fire(isNear, true);
    expect(clips().map((v) => v.getAttribute('src'))).toEqual([
      '/landing/sa/landmark-capetown.mp4',
      '/landing/sa/landmark-joburg.mp4',
      '/landing/sa/landmark-pretoria.mp4',
    ]);
    for (const v of clips()) expect(v.getAttribute('preload')).toBe('none');
    expect(play).not.toHaveBeenCalled();
  });

  it('plays Cape Town, Johannesburg, Pretoria once, holding each last frame', () => {
    const { container, io, clips, play } = renderDesktop();
    io.fire(isNear, true);
    io.fire(isInView, true);
    const [c0, c1, c2] = clips() as [HTMLVideoElement, HTMLVideoElement, HTMLVideoElement];
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(c0);
    fireEvent.playing(c0);
    expect(visibleIndex(container)).toBe(0);
    fireEvent.ended(c0);
    expect(play.mock.contexts[1]).toBe(c1);
    expect(visibleIndex(container)).toBe(0);
    fireEvent.playing(c1);
    expect(visibleIndex(container)).toBe(1);
    fireEvent.ended(c1);
    expect(play.mock.contexts[2]).toBe(c2);
    expect(visibleIndex(container)).toBe(1);
    fireEvent.playing(c2);
    expect(visibleIndex(container)).toBe(2);
    fireEvent.ended(c2);
    expect(play).toHaveBeenCalledTimes(3);
    expect(visibleIndex(container)).toBe(2);
  });

  it('pauses when it leaves view and resumes the same clip', () => {
    const { io, clips, play, pause } = renderDesktop();
    io.fire(isNear, true);
    io.fire(isInView, true);
    const [c0, c1] = clips() as [HTMLVideoElement, HTMLVideoElement];
    fireEvent.playing(c0);
    fireEvent.ended(c0);
    fireEvent.playing(c1);
    io.fire(isInView, false);
    expect(pause.mock.contexts.at(-1)).toBe(c1);
    play.mockClear();
    io.fire(isInView, true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(c1);
  });

  it('restarts from Cape Town on the next entry after it finished', () => {
    const { io, clips, play } = renderDesktop();
    io.fire(isNear, true);
    io.fire(isInView, true);
    for (const v of clips()) { fireEvent.playing(v); fireEvent.ended(v); }
    io.fire(isInView, false);
    const c0 = clips()[0] as HTMLVideoElement;
    c0.currentTime = 7;
    play.mockClear();
    io.fire(isInView, true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(c0);
    expect(c0.currentTime).toBe(0);
  });

  it('falls back to the poster strip when playback is refused', async () => {
    setRiverEnv(DESKTOP);
    const io = installIntersectionObserver();
    stubMediaPlayback(true);
    const { container } = render(<LandingSouthAfricaBand />);
    io.fire(isNear, true);
    io.fire(isInView, true);
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(videos(container)).toHaveLength(0));
    expect(container.querySelectorAll('img')).toHaveLength(3);
  });
});
