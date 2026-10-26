/**
 * Undo (spec §5.5): one entry per user action, however many cells it touched;
 * a new entry clears redo; at most 100 entries; only an explicit clear (reload,
 * version or view switch) empties it, never a save.
 */
import { describe, it, expect } from 'vitest';
import { type Change, UndoStack, UNDO_LIMIT } from '@/modules/accounting/services/budgets/grid/undo';

const ch = (key: string, before: number | null, after: number | null): Change => ({ key, before, after });
const paste12 = Array.from({ length: 12 }, (_, i) => ch(`a|||2027-${String(i + 1).padStart(2, '0')}`, null, i * 100));

describe('UndoStack', () => {
  it('a 12-cell paste is one entry: one undo returns all 12', () => {
    const u = new UndoStack();
    u.push(paste12);
    expect(u.size).toBe(1);
    expect(u.undo()).toEqual(paste12);
    expect(u.canUndo).toBe(false);
  });

  it('undo then redo returns the same entry; a new push clears redo', () => {
    const u = new UndoStack();
    u.push([ch('k1', null, 1)]);
    u.push([ch('k2', 2, 3)]);
    expect(u.undo()).toEqual([ch('k2', 2, 3)]);
    expect(u.canRedo).toBe(true);
    expect(u.redo()).toEqual([ch('k2', 2, 3)]);
    u.undo();
    u.push([ch('k3', null, 4)]);
    expect(u.canRedo).toBe(false);
    expect(u.redo()).toBeNull();
  });

  it('drops no-op changes and ignores an empty entry', () => {
    const u = new UndoStack();
    u.push([ch('k', 5, 5)]);
    u.push([]);
    expect(u.size).toBe(0);
    u.push([ch('k', 5, 5), ch('j', null, 0)]);
    expect(u.undo()).toEqual([ch('j', null, 0)]);
  });

  it(`keeps at most ${UNDO_LIMIT} entries, dropping the oldest`, () => {
    const u = new UndoStack();
    for (let i = 0; i < UNDO_LIMIT + 5; i++) u.push([ch(`k${i}`, null, i)]);
    expect(u.size).toBe(UNDO_LIMIT);
    let last: Change[] | null = null;
    while (u.canUndo) last = u.undo();
    expect(last).toEqual([ch('k5', null, 5)]);
  });

  it('nothing but clear() empties it (a save keeps the stack)', () => {
    const u = new UndoStack();
    u.push(paste12);
    expect(u.canUndo).toBe(true);
    u.undo();
    expect(u.canRedo).toBe(true);
    u.clear();
    expect(u.canUndo).toBe(false);
    expect(u.canRedo).toBe(false);
    expect(u.undo()).toBeNull();
    expect(u.redo()).toBeNull();
  });
});

describe('UndoStack entries are not shared with the caller', () => {
  it('mutating the pushed array or a returned entry cannot change the stack', () => {
    const u = new UndoStack();
    const changes = [ch('k', null, 1)];
    u.push(changes);
    changes[0]!.after = 99;
    const e = u.undo()!;
    expect(e).toEqual([ch('k', null, 1)]);
    expect(Object.isFrozen(e) && Object.isFrozen(e[0])).toBe(true);
  });
});
