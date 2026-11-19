import { describe, it, expect } from 'vitest';
import { anchoredMenuStyle, placeFlyout } from '@/components/layout/menuPosition';

const rect = (left: number, right: number, bottom = 48) => ({ left, right, bottom, top: bottom - 32, width: right - left, height: 32, x: left, y: bottom - 32, toJSON: () => ({}) }) as DOMRect;

describe('anchoredMenuStyle', () => {
  it('right-aligns the menu under its button when there is room', () => {
    expect(anchoredMenuStyle(rect(900, 932), 256, { width: 1568, height: 900 })).toMatchObject({ left: 932 - 256, width: 256, top: 56 });
  });

  it('keeps a menu whose button is near the left edge inside a 390px screen', () => {
    const s = anchoredMenuStyle(rect(166, 198), 256, { width: 390, height: 844 });
    expect(s.left).toBe(8);
    expect((s.left as number) + (s.width as number)).toBeLessThanOrEqual(382);
  });

  it('narrows a menu wider than the screen to the screen, and caps its height to the space below the button', () => {
    const s = anchoredMenuStyle(rect(300, 330), 640, { width: 390, height: 900 });
    expect(s).toMatchObject({ left: 8, width: 374, maxHeight: 900 - 56 - 8, overflowY: 'auto' });
  });
});

// ─── Nav fly-outs (top nav and sidebar, every nesting level) ──────────────────

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });
const VP = { width: 1366, height: 768 };

describe('placeFlyout', () => {
  it('leaves a sub-panel that fits exactly where it opened before: beside its row, level with it', () => {
    expect(placeFlyout(box(300, 200, 210, 40), { width: 220, height: 300 }, VP, 'beside')).toEqual({ top: 200, left: 510, dir: 'right' });
  });

  it('leaves a tab menu that fits under its tab, left-aligned', () => {
    expect(placeFlyout(box(400, 96, 90, 40), { width: 220, height: 400 }, VP, 'below')).toEqual({ top: 136, left: 400, dir: 'right' });
  });

  it('shifts a sub-panel up so it ends 8px above the bottom edge (Sales > Transactions at 1366x768)', () => {
    const p = placeFlyout(box(300, 400, 210, 40), { width: 220, height: 420 }, VP, 'beside');
    expect(p).toEqual({ top: 768 - 8 - 420, left: 510, dir: 'right' });
  });

  it('opens a sub-panel to the left of its row when the right side has no room (Library third level)', () => {
    const p = placeFlyout(box(1060, 230, 210, 40), { width: 210, height: 200 }, VP, 'beside');
    expect(p).toEqual({ top: 230, left: 1060 - 210, dir: 'left' });
  });

  it('keeps opening to the left below a panel that already opened to the left, while there is room', () => {
    expect(placeFlyout(box(600, 230, 210, 40), { width: 210, height: 200 }, VP, 'beside', 'left')).toMatchObject({ left: 390, dir: 'left' });
  });

  it('turns back to the right when a left-preferring panel has no room on the left', () => {
    expect(placeFlyout(box(100, 230, 210, 40), { width: 210, height: 200 }, VP, 'beside', 'left')).toMatchObject({ left: 310, dir: 'right' });
  });

  it('with no room on either side, clamps the panel inside the screen on the roomier side', () => {
    const p = placeFlyout(box(200, 100, 300, 40), { width: 360, height: 200 }, { width: 700, height: 768 }, 'beside');
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 360).toBeLessThanOrEqual(700 - 8);
    expect(p.dir).toBe('right');
  });

  it('flips left and shifts up at once when it passes both the right and the bottom edge', () => {
    const p = placeFlyout(box(1060, 600, 210, 40), { width: 210, height: 300 }, VP, 'beside');
    expect(p).toEqual({ top: 768 - 8 - 300, left: 850, dir: 'left' });
  });

  it('opens a sub-panel with sections of its own on the side where its own sub-panels fit too (Library at 1366)', () => {
    // Right of the Library menu there is room for Accounting but not for General Ledger beyond it: a third level
    // flipped back to the left would cover the Library menu, so the cascade goes left from the second level.
    const p = placeFlyout(box(864, 300, 198, 40), { width: 210, height: 300, nested: true }, VP, 'beside');
    expect(p).toMatchObject({ left: 864 - 210, dir: 'left' });
  });

  it('keeps a nested sub-panel where it was when both levels fit on the right', () => {
    expect(placeFlyout(box(300, 200, 210, 40), { width: 220, height: 300, nested: true }, VP, 'beside')).toEqual({ top: 200, left: 510, dir: 'right' });
  });

  it('falls back to the panel alone when no side has room for two levels', () => {
    const p = placeFlyout(box(250, 100, 200, 40), { width: 210, height: 200, nested: true }, { width: 700, height: 768 }, 'beside');
    expect(p).toMatchObject({ left: 450, dir: 'right' });
  });

  it('with no room on either side, takes the roomier side even when it is the left', () => {
    expect(placeFlyout(box(214, 100, 420, 40), { width: 210, height: 200 }, { width: 700, height: 768 }, 'beside')).toEqual({ top: 100, left: 8, dir: 'left' });
  });

  it('does not count a left side that would end inside the 8px gutter as room', () => {
    // 4px to spare on the left is not enough; the right (208 of 210) is roomier, so the panel is pulled in there.
    expect(placeFlyout(box(214, 100, 570, 40), { width: 210, height: 200 }, { width: 1000, height: 768 }, 'beside')).toEqual({ top: 100, left: 782, dir: 'right' });
  });

  it('keeps a sub-panel that follows a row scrolled above the window inside the top gutter', () => {
    expect(placeFlyout(box(300, -50, 210, 40), { width: 220, height: 300 }, VP, 'beside')).toMatchObject({ top: 8 });
  });

  it('never gives a tab menu less than 80px, even when its tab sits at the bottom of the window', () => {
    expect(placeFlyout(box(400, 722, 90, 40), { width: 220, height: 300 }, VP, 'below')).toMatchObject({ top: 762, maxHeight: 80 });
  });

  it('never gives a sub-panel less than 80px in a window too short for it', () => {
    expect(placeFlyout(box(300, 10, 210, 40), { width: 220, height: 300 }, { width: 1366, height: 60 }, 'beside')).toMatchObject({ top: 8, maxHeight: 80 });
  });

  it('caps a sub-panel taller than the screen to the screen and lets it scroll', () => {
    const p = placeFlyout(box(300, 400, 210, 40), { width: 220, height: 900 }, VP, 'beside');
    expect(p).toEqual({ top: 8, left: 510, maxHeight: 768 - 16, dir: 'right' });
  });

  it('caps a tab menu taller than the room under its tab, without covering the tab', () => {
    const p = placeFlyout(box(400, 96, 90, 40), { width: 220, height: 700 }, { width: 1280, height: 720 }, 'below');
    expect(p).toEqual({ top: 136, left: 400, maxHeight: 720 - 8 - 136, dir: 'right' });
  });

  it('pulls a tab menu that would pass the right edge back inside (Library at 1024)', () => {
    const p = placeFlyout(box(960, 96, 60, 40), { width: 220, height: 400 }, { width: 1024, height: 768 }, 'below');
    expect(p).toEqual({ top: 136, left: 1024 - 8 - 220, dir: 'right' });
  });

  it('measures from where the row really is, so a banner above the nav moves the panel with it', () => {
    const without = placeFlyout(box(300, 300, 210, 40), { width: 220, height: 440 }, VP, 'beside');
    const withBanner = placeFlyout(box(300, 337, 210, 40), { width: 220, height: 440 }, VP, 'beside');
    expect(without.top).toBe(300);
    expect(withBanner.top).toBe(768 - 8 - 440);
  });
});
