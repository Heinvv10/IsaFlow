/**
 * Undo/redo for the grid (spec §5.5). One entry per user action (commit,
 * paste, fill, clear, row action, grain change, import apply), however many
 * cells it touched. Undo hands back the entry so the store restores `before`
 * for every key; redo re-applies `after`. A save does not clear the stack;
 * reload, version switch and view switch call `clear()`.
 */
import type { CellKey } from './cellKey';

export interface Change {
  key: CellKey;
  before: number | null;
  after: number | null;
}

export const UNDO_LIMIT = 100;

export class UndoStack {
  private done: Change[][] = [];
  private undone: Change[][] = [];

  constructor(private readonly limit = UNDO_LIMIT) {}

  push(changes: readonly Change[]): void {
    const entry = changes.filter(c => c.before !== c.after);
    if (entry.length === 0) return;
    this.done.push(entry);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  undo(): Change[] | null {
    const entry = this.done.pop();
    if (!entry) return null;
    this.undone.push(entry);
    return entry;
  }

  redo(): Change[] | null {
    const entry = this.undone.pop();
    if (!entry) return null;
    this.done.push(entry);
    return entry;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
  get size(): number { return this.done.length; }
}
