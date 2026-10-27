import { describe, it, expect } from 'vitest';
import { anchoredMenuStyle } from '@/components/layout/menuPosition';

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
