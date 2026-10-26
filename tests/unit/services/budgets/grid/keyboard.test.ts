/**
 * The spec §5.2 key table as reducer cases: nav keys, edit keys, mouse, and the
 * effects the DOM hook executes. One `it` per table row.
 */
import { describe, it, expect } from 'vitest';
import {
  type GridAction, type GridContext, type GridState, gridReducer, initialGridState,
} from '@/modules/accounting/services/budgets/grid/keyboard';
import type { GridShape, Pos } from '@/modules/accounting/services/budgets/grid/selection';

// 0 section, 1-2 lines, 3 subtotal, 4 GP, 5 section, 6-8 lines, 9 subtotal, 10 NP; 12 months + FY total
const SHAPE: GridShape = {
  rowKinds: ['section', 'line', 'line', 'subtotal', 'total', 'section', 'line', 'line', 'line', 'subtotal', 'grand'],
  cols: 13,
};
const READONLY_ROW = 7;
const CTX: GridContext = {
  shape: SHAPE,
  isEditable: p => p.r !== READONLY_ROW,
  readReason: p => (p.r === READONLY_ROW ? 'Budgeted by CC1, switch view to edit' : null),
  rawValue: p => (p.r === 1 && p.c === 0 ? '1234.50' : ''),
};

const at = (r: number, c: number, over: Partial<GridState> = {}): GridState =>
  ({ ...initialGridState(SHAPE), focus: { r, c }, anchor: { r, c }, ...over });
const key = (k: string, mods: { shift?: boolean; ctrl?: boolean } = {}): GridAction => ({ type: 'key', key: k, ...mods });
const run = (s: GridState, a: GridAction) => gridReducer(s, a, CTX);
const focus = (s: GridState, a: GridAction): Pos => run(s, a).state.focus;
const types = (s: GridState, a: GridAction) => run(s, a).effects.map(e => e.type);

describe('initial state', () => {
  it('focuses the first month of the first line row, in nav mode', () => {
    expect(initialGridState(SHAPE)).toMatchObject({ focus: { r: 1, c: 0 }, anchor: { r: 1, c: 0 }, mode: 'nav' });
  });
});

describe('nav keys', () => {
  it('arrows move 1 and collapse the selection; vertical skips non-line rows', () => {
    const s = at(2, 3, { anchor: { r: 1, c: 0 } });
    expect(run(s, key('ArrowDown')).state).toMatchObject({ focus: { r: 6, c: 3 }, anchor: { r: 6, c: 3 } });
    expect(focus(s, key('ArrowRight'))).toEqual({ r: 2, c: 4 });
    expect(focus(s, key('ArrowLeft'))).toEqual({ r: 2, c: 2 });
    expect(focus(s, key('ArrowUp'))).toEqual({ r: 1, c: 3 });
  });

  it('Shift+arrow extends from the anchor', () => {
    const r = run(at(1, 1), key('ArrowDown', { shift: true })).state;
    expect(r).toMatchObject({ anchor: { r: 1, c: 1 }, focus: { r: 2, c: 1 } });
    expect(run(r, key('ArrowRight', { shift: true })).state).toMatchObject({ anchor: { r: 1, c: 1 }, focus: { r: 2, c: 2 } });
  });

  it('Ctrl+arrow jumps to the edge', () => {
    expect(focus(at(6, 3), key('ArrowDown', { ctrl: true }))).toEqual({ r: 8, c: 3 });
    expect(focus(at(6, 3), key('ArrowRight', { ctrl: true }))).toEqual({ r: 6, c: 12 });
  });

  it('Home/End go to the first/last MONTH of the row; Ctrl+Home/End to the first/last line row', () => {
    expect(focus(at(6, 5), key('Home'))).toEqual({ r: 6, c: 0 });
    expect(focus(at(6, 5), key('End'))).toEqual({ r: 6, c: 11 });
    expect(focus(at(6, 5), key('Home', { ctrl: true }))).toEqual({ r: 1, c: 0 });
    expect(focus(at(1, 5), key('End', { ctrl: true }))).toEqual({ r: 8, c: 11 });
  });

  it('PageUp/PageDown move 20 line rows, clamped at the ends', () => {
    // 30 line rows under one section head: rows 1..30
    const tall: GridShape = { rowKinds: ['section', ...Array<'line'>(30).fill('line'), 'grand'], cols: 13 };
    const ctx = { ...CTX, shape: tall, isEditable: () => true, readReason: () => null };
    const s = { ...initialGridState(tall), focus: { r: 2, c: 1 }, anchor: { r: 2, c: 1 } };
    expect(gridReducer(s, key('PageDown'), ctx).state.focus).toEqual({ r: 22, c: 1 });
    const low = { ...s, focus: { r: 25, c: 1 }, anchor: { r: 25, c: 1 } };
    expect(gridReducer(low, key('PageUp'), ctx).state.focus).toEqual({ r: 5, c: 1 });
    expect(focus(at(1, 2), key('PageDown'))).toEqual({ r: 8, c: 2 });
    expect(focus(at(8, 2), key('PageUp'))).toEqual({ r: 1, c: 2 });
  });

  it('Tab/Shift+Tab move right/left and stop at the row edge; Tab off the last column exits', () => {
    expect(focus(at(1, 3), key('Tab'))).toEqual({ r: 1, c: 4 });
    expect(focus(at(1, 3), key('Tab', { shift: true }))).toEqual({ r: 1, c: 2 });
    expect(focus(at(1, 0), key('Tab', { shift: true }))).toEqual({ r: 1, c: 0 });
    const exit = run(at(1, 12), key('Tab'));
    expect(exit.state.focus).toEqual({ r: 1, c: 12 });
    expect(exit.effects).toEqual([{ type: 'exit' }]);
  });

  it('Enter moves down and Shift+Enter up (Excel)', () => {
    expect(focus(at(2, 3), key('Enter'))).toEqual({ r: 6, c: 3 });
    expect(focus(at(6, 3), key('Enter', { shift: true }))).toEqual({ r: 2, c: 3 });
  });

  it.each(['5', '0', '-', '.', '(', 'R'])('typing %j enters edit with draft = that char (overwrite)', ch => {
    expect(run(at(1, 0), key(ch)).state).toMatchObject({ mode: 'edit', draft: ch, editOrigin: 'type' });
  });

  it('typing on a read-only cell announces why and stays in nav', () => {
    const r = run(at(READONLY_ROW, 0), key('5'));
    expect(r.state.mode).toBe('nav');
    expect(r.effects).toEqual([{ type: 'announce', message: 'Budgeted by CC1, switch view to edit' }]);
  });

  it('F2 and double-click edit the current raw value', () => {
    expect(run(at(1, 0), key('F2')).state).toMatchObject({ mode: 'edit', draft: '1234.50', editOrigin: 'f2' });
    expect(run(at(2, 2), { type: 'dblclick', pos: { r: 1, c: 0 } }).state)
      .toMatchObject({ mode: 'edit', draft: '1234.50', editOrigin: 'dblclick', focus: { r: 1, c: 0 } });
  });

  it('Delete/Backspace clear every editable cell in the selection, as one effect', () => {
    const s = at(8, 1, { anchor: { r: 6, c: 0 } });
    const r = run(s, key('Delete'));
    expect(r.effects).toEqual([{ type: 'clear', cells: [{ r: 6, c: 0 }, { r: 6, c: 1 }, { r: 8, c: 0 }, { r: 8, c: 1 }] }]);
    expect(types(s, key('Backspace'))).toEqual(['clear']);
    expect(types(at(READONLY_ROW, 0), key('Delete'))).toEqual(['announce']);
  });

  it('Ctrl+C / Ctrl+X / Ctrl+V leave the native clipboard event to fire', () => {
    const s = at(2, 1, { anchor: { r: 1, c: 0 } });
    const rect = { top: 1, left: 0, bottom: 2, right: 1 };
    expect(run(s, key('c', { ctrl: true }))).toMatchObject({ handled: false, effects: [{ type: 'copy', rect, cut: false }] });
    expect(run(s, key('x', { ctrl: true }))).toMatchObject({ handled: false, effects: [{ type: 'copy', rect, cut: true }] });
    expect(run(s, key('v', { ctrl: true }))).toMatchObject({ handled: false, effects: [{ type: 'paste', rect }] });
  });

  it('Ctrl+D / Ctrl+R fill down / right', () => {
    const s = at(2, 3, { anchor: { r: 1, c: 0 } });
    expect(run(s, key('d', { ctrl: true })).effects).toEqual([{ type: 'fillDown', rect: { top: 1, left: 0, bottom: 2, right: 3 } }]);
    expect(types(s, key('r', { ctrl: true }))).toEqual(['fillRight']);
  });

  it('Ctrl+Z undo; Ctrl+Y and Ctrl+Shift+Z redo; Ctrl+S save', () => {
    expect(types(at(1, 0), key('z', { ctrl: true }))).toEqual(['undo']);
    expect(types(at(1, 0), key('y', { ctrl: true }))).toEqual(['redo']);
    expect(types(at(1, 0), key('Z', { ctrl: true, shift: true }))).toEqual(['redo']);
    expect(run(at(1, 0), key('s', { ctrl: true }))).toMatchObject({ handled: true, effects: [{ type: 'save' }] });
  });

  it('Ctrl+A selects every month cell of every line row', () => {
    expect(run(at(6, 4), key('a', { ctrl: true })).state).toMatchObject({ anchor: { r: 1, c: 0 }, focus: { r: 8, c: 11 } });
  });

  it('Esc collapses the selection', () => {
    expect(run(at(2, 3, { anchor: { r: 1, c: 0 } }), key('Escape')).state.anchor).toEqual({ r: 2, c: 3 });
  });
});

describe('edit keys', () => {
  const editing = (r: number, c: number, draft = '99') => at(r, c, { mode: 'edit', draft, editOrigin: 'type' });

  it('Enter commits then moves down; Shift+Enter up; Tab right; Shift+Tab left', () => {
    const e = run(editing(2, 3), key('Enter'));
    expect(e.effects).toEqual([{ type: 'commit', pos: { r: 2, c: 3 }, draft: '99', isTotal: false }]);
    expect(e.state).toMatchObject({ mode: 'nav', focus: { r: 6, c: 3 }, draft: '' });
    expect(focus(editing(6, 3), key('Enter', { shift: true }))).toEqual({ r: 2, c: 3 });
    expect(focus(editing(6, 3), key('Tab'))).toEqual({ r: 6, c: 4 });
    expect(focus(editing(6, 3), key('Tab', { shift: true }))).toEqual({ r: 6, c: 2 });
  });

  it('a commit in the FY total column is flagged for an even spread', () => {
    expect(run(editing(1, 12), key('Enter')).effects[0]).toMatchObject({ type: 'commit', isTotal: true });
  });

  it('Esc cancels the draft: no commit, back to nav, focus kept', () => {
    const r = run(editing(2, 3), key('Escape'));
    expect(r.effects).toEqual([]);
    expect(r.state).toMatchObject({ mode: 'nav', focus: { r: 2, c: 3 }, draft: '' });
  });

  it('←/→ move the caret, not the cell', () => {
    for (const k of ['ArrowLeft', 'ArrowRight']) {
      const r = run(editing(2, 3), key(k));
      expect(r).toMatchObject({ handled: false, effects: [] });
      expect(r.state).toMatchObject({ mode: 'edit', focus: { r: 2, c: 3 } });
    }
  });

  it('draft changes are kept; blur commits in place', () => {
    const d = run(editing(2, 3, '1'), { type: 'draft', draft: '12' }).state;
    expect(d.draft).toBe('12');
    const b = run(d, { type: 'blur' });
    expect(b.effects).toEqual([{ type: 'commit', pos: { r: 2, c: 3 }, draft: '12', isTotal: false }]);
    expect(b.state).toMatchObject({ mode: 'nav', focus: { r: 2, c: 3 } });
  });

  it('Ctrl+S commits then saves', () => {
    expect(types(editing(2, 3), key('s', { ctrl: true }))).toEqual(['commit', 'save']);
  });
});

describe('mouse', () => {
  it('click focuses, shift+click and drag extend', () => {
    expect(run(at(1, 0), { type: 'click', pos: { r: 6, c: 2 } }).state).toMatchObject({ focus: { r: 6, c: 2 }, anchor: { r: 6, c: 2 } });
    expect(run(at(1, 0), { type: 'click', pos: { r: 6, c: 2 }, shift: true }).state).toMatchObject({ anchor: { r: 1, c: 0 }, focus: { r: 6, c: 2 } });
    expect(run(at(1, 0), { type: 'drag', pos: { r: 2, c: 4 } }).state).toMatchObject({ anchor: { r: 1, c: 0 }, focus: { r: 2, c: 4 } });
  });

  it('clicking another cell while editing commits first', () => {
    const r = run(at(1, 1, { mode: 'edit', draft: '7', editOrigin: 'f2' }), { type: 'click', pos: { r: 6, c: 0 } });
    expect(r.effects).toEqual([{ type: 'commit', pos: { r: 1, c: 1 }, draft: '7', isTotal: false }]);
    expect(r.state).toMatchObject({ mode: 'nav', focus: { r: 6, c: 0 } });
  });

  it('a click on a non-line row is ignored', () => {
    expect(run(at(1, 0), { type: 'click', pos: { r: 3, c: 0 } }).state.focus).toEqual({ r: 1, c: 0 });
  });
});

describe('edges the table implies', () => {
  const editing = (r: number, c: number) => at(r, c, { mode: 'edit', draft: '5', editOrigin: 'type' });

  it('every Ctrl action but the clipboard ones is handled (preventDefault: Ctrl+D would bookmark)', () => {
    for (const k of ['d', 'r', 'z', 'y', 's', 'a', 'Home', 'End', 'ArrowDown']) {
      expect(run(at(1, 0), key(k, { ctrl: true })).handled).toBe(true);
    }
  });

  it('Shift+Tab from the FY total moves left; it never exits', () => {
    expect(run(at(1, 12), key('Tab', { shift: true }))).toMatchObject({ state: { focus: { r: 1, c: 11 } }, effects: [] });
  });

  it('Tab while editing the last column commits, leaves edit mode and exits', () => {
    const r = run(editing(1, 12), key('Tab'));
    expect(r.effects.map(e => e.type)).toEqual(['commit', 'exit']);
    expect(r.state.mode).toBe('nav');
  });

  it('a click on the cell being edited is left to the input (caret placement)', () => {
    const r = run(editing(1, 3), { type: 'click', pos: { r: 1, c: 3 } });
    expect(r).toMatchObject({ handled: false, effects: [], state: { mode: 'edit', draft: '5' } });
  });

  it('a drag while editing does not move the selection', () => {
    expect(run(editing(1, 3), { type: 'drag', pos: { r: 6, c: 5 } }).state).toMatchObject({ mode: 'edit', focus: { r: 1, c: 3 } });
  });

  it.each(['9', 'r'])('%j also starts an overwrite edit', ch => {
    expect(run(at(1, 0), key(ch)).state).toMatchObject({ mode: 'edit', draft: ch });
  });

  it('Alt+digit and other keys do not start an edit', () => {
    expect(run(at(1, 0), { type: 'key', key: '5', alt: true })).toMatchObject({ handled: false, state: { mode: 'nav' } });
    expect(run(at(1, 0), key('x'))).toMatchObject({ handled: false, state: { mode: 'nav' } });
  });

  it('starting an edit collapses the selection to the edited cell', () => {
    expect(run(at(2, 3, { anchor: { r: 1, c: 0 } }), key('7')).state.anchor).toEqual({ r: 2, c: 3 });
  });

  it('Delete on a read-only cell announces its reason', () => {
    expect(run(at(READONLY_ROW, 2), key('Delete')).effects)
      .toEqual([{ type: 'announce', message: 'Budgeted by CC1, switch view to edit' }]);
  });

  it('Delete never clears the FY total column (it is derived from the months)', () => {
    const r = run(at(1, 12, { anchor: { r: 1, c: 11 } }), key('Delete'));
    expect(r.effects).toEqual([{ type: 'clear', cells: [{ r: 1, c: 11 }] }]);
    expect(run(at(1, 12), key('Delete')).effects[0]).toMatchObject({ type: 'announce' });
  });
});
