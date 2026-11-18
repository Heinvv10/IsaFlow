import { describe, it, expect } from 'vitest';
import { headsFor } from '@/components/layout/useFlyoutSection';

// A sub-panel open to the right of a 210px parent panel: x 510..720, y 150..600.
const right = { left: 510, right: 720, top: 150, bottom: 600 };
// The same panel opened to the left of its row: x 90..300.
const left = { left: 90, right: 300, top: 150, bottom: 600 };

describe('headsFor (hover intent)', () => {
  it('a diagonal move from a row toward the lower part of the open sub-panel is heading for it', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 420, y: 240 }, right)).toBe(true);
  });

  it('a move straight down the rows is not', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 400, y: 240 }, right)).toBe(false);
  });

  it('a move away from the panel is not', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 380, y: 240 }, right)).toBe(false);
  });

  it('a move whose line passes below the panel is not', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 410, y: 300 }, right)).toBe(false);
  });

  it('a pointer that has not moved is not', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 400, y: 200 }, right)).toBe(false);
  });

  it('works the other way round for a panel that opened to the left', () => {
    expect(headsFor({ x: 400, y: 200 }, { x: 380, y: 240 }, left)).toBe(true);
    expect(headsFor({ x: 400, y: 200 }, { x: 420, y: 240 }, left)).toBe(false);
  });

  it('a pointer already level with the panel horizontally is not heading for its edge', () => {
    expect(headsFor({ x: 600, y: 100 }, { x: 610, y: 140 }, right)).toBe(false);
  });
});
